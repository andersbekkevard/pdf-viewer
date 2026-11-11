// Fuzzy matching for the quick-open panel (overlay-quickopen.js).
//
// A query matches a text when each of its space-separated tokens is a
// subsequence of the text, ignoring case and diacritics. The score follows
// fzy: a match counts more at the start of a word and when it continues the
// previous match, and less for every character skipped. The best
// alignment is found with a small dynamic program per token, so "mth" in
// "Methods" lights M-t-h, not the first t and h it meets.
//
//   prepare(text)          -> a target: the text plus its folded form; build
//                             once per candidate, not per keystroke
//   parseQuery(query)      -> tokens, folded; reuse for every candidate
//   match(tokens, target)  -> {score, positions} or null
//   matchAny(tokens, fields) -> the same over several fields, {target, penalty}
//   highlight(target, positions) -> HTML with matched characters in <mark>
import { escapeHtml } from './overlay-dom.js';

var GAP_LEADING = -0.005;
var GAP_TRAILING = -0.005;
var GAP_INNER = -0.01;
var MATCH_CONSECUTIVE = 1.0;
var BONUS_SLASH = 0.9;
var BONUS_WORD = 0.8;
var BONUS_CAPITAL = 0.7;
var BONUS_DOT = 0.6;
// Longer texts are matched on their first MAX_TEXT characters only.
var MAX_TEXT = 160;
var NEG = -Infinity;

var COMBINING = /[̀-ͯ]/g;
var ASCII = /^[\x00-\x7f]*$/;

// Lowercase without diacritics, character by character, so every folded
// character maps back to one character of the original for highlighting.
function fold(text) {
    var s = String(text == null ? '' : text);
    if (ASCII.test(s)) return { folded: s.toLowerCase(), map: null };
    var out = '', map = [];
    for (var i = 0; i < s.length; i++) {
        var f = s[i].normalize('NFD').replace(COMBINING, '').toLowerCase();
        for (var k = 0; k < f.length; k++) { out += f[k]; map.push(i); }
    }
    return { folded: out, map: map };
}

function bonusFor(original, i) {
    if (i === 0) return BONUS_SLASH;
    var prev = original[i - 1], ch = original[i];
    if (prev === '/' || prev === '\\') return BONUS_SLASH;
    if (prev === ' ' || prev === '-' || prev === '_' || prev === '(' || prev === '[' || prev === ':'
        || prev === '"' || prev === '“' || prev === '‘' || prev === "'") return BONUS_WORD;
    if (prev === '.') return /[0-9]/.test(ch) ? BONUS_WORD : BONUS_DOT;
    if (/[0-9]/.test(prev) && !/[0-9]/.test(ch)) return BONUS_WORD;
    if (!/[0-9]/.test(prev) && /[0-9]/.test(ch)) return BONUS_WORD;
    if (prev.toLowerCase() === prev && ch.toLowerCase() !== ch) return BONUS_CAPITAL;
    return 0;
}

export function prepare(text) {
    var original = String(text == null ? '' : text);
    var f = fold(original);
    var folded = f.folded.length > MAX_TEXT ? f.folded.slice(0, MAX_TEXT) : f.folded;
    return { text: original, folded: folded, map: f.map, bonus: null };
}

export function parseQuery(query) {
    var tokens = fold(String(query || '')).folded.split(/\s+/).filter(Boolean);
    return tokens;
}

function bonuses(target) {
    if (target.bonus) return target.bonus;
    var n = target.folded.length, out = new Float32Array(n);
    for (var j = 0; j < n; j++) {
        var i = target.map ? target.map[j] : j;
        // The first folded character of an original character carries its
        // bonus; the rest of a decomposed character continue it.
        out[j] = target.map && j > 0 && target.map[j - 1] === i ? 0 : bonusFor(target.text, i);
    }
    target.bonus = out;
    return out;
}

// Shared scratch for the dynamic program, grown as needed.
var D = new Float64Array(0), M = new Float64Array(0);
function scratch(size) {
    if (D.length < size) { D = new Float64Array(size * 2); M = new Float64Array(size * 2); }
}

function isSubsequence(needle, hay) {
    var j = 0;
    for (var i = 0; i < needle.length; i++) {
        j = hay.indexOf(needle[i], j);
        if (j === -1) return false;
        j++;
    }
    return true;
}

// fzy's score for one token in one text, with the matched positions.
function matchToken(token, target) {
    var hay = target.folded, n = hay.length, m = token.length;
    if (!m) return { score: 0, positions: [] };
    if (m > n || !isSubsequence(token, hay)) return null;
    if (m === n) {
        var all = [];
        for (var a = 0; a < n; a++) all.push(a);
        return { score: Infinity, positions: all };
    }
    var bonus = bonuses(target);
    scratch(m * n);
    for (var i = 0; i < m; i++) {
        var prev = NEG;
        var gap = i === m - 1 ? GAP_TRAILING : GAP_INNER;
        var qc = token[i];
        var row = i * n, up = (i - 1) * n;
        for (var j = 0; j < n; j++) {
            if (qc === hay[j]) {
                var score = NEG;
                if (i === 0) score = j * GAP_LEADING + bonus[j];
                else if (j > 0) score = Math.max(M[up + j - 1] + bonus[j], D[up + j - 1] + MATCH_CONSECUTIVE);
                D[row + j] = score;
                M[row + j] = prev = Math.max(score, prev + gap);
            } else {
                D[row + j] = NEG;
                M[row + j] = prev = prev + gap;
            }
        }
    }
    var positions = new Array(m);
    var required = false, jj = n - 1;
    for (var k = m - 1; k >= 0; k--) {
        for (; jj >= 0; jj--) {
            var d = D[k * n + jj];
            if (d !== NEG && (required || d === M[k * n + jj])) {
                required = k > 0 && jj > 0 && M[k * n + jj] === D[(k - 1) * n + jj - 1] + MATCH_CONSECUTIVE;
                positions[k] = jj--;
                break;
            }
        }
    }
    return { score: M[(m - 1) * n + n - 1], positions: positions };
}

// A token's characters scattered through the middle of words are noise, not
// a match: below this score per character the token does not count. A word
// start earns about 0.8 and a continued run 1.0, so prefixes, initials and
// plain substrings pass, and "zzz" across three words does not.
function enough(score, length) {
    return score === Infinity || score >= (length === 1 ? 0.5 : 0.35 * length);
}

// Every token must match; the score is their sum, and an exact or prefix
// match of the whole query ranks above a scattered one.
export function match(tokens, target) {
    var hit = matchAny(tokens, [{ target: target, penalty: 0 }]);
    return hit && { score: hit.score, positions: hit.positions[0] };
}

// The same over several fields of one candidate, such as a title, an author
// and a file name: each token takes the field where it scores best after
// that field's penalty. positions[k] are the matches in fields[k]; the
// prefix bonus counts for the first field only.
export function matchAny(tokens, fields) {
    if (!tokens.length) return { score: 0, positions: fields.map(function () { return []; }) };
    var total = 0, positions = fields.map(function () { return []; });
    for (var t = 0; t < tokens.length; t++) {
        var best = null, bestField = -1;
        for (var f = 0; f < fields.length; f++) {
            if (!fields[f].target) continue;
            var hit = matchToken(tokens[t], fields[f].target);
            if (!hit || !enough(hit.score, tokens[t].length)) continue;
            var score = (hit.score === Infinity ? tokens[t].length + 2 : hit.score) - (fields[f].penalty || 0);
            if (!best || score > best.score) { best = { score: score, positions: hit.positions }; bestField = f; }
        }
        if (!best) return null;
        total += best.score;
        for (var p = 0; p < best.positions.length; p++) positions[bestField].push(best.positions[p]);
    }
    if (fields[0].target && fields[0].target.folded.indexOf(tokens.join(' ')) === 0) total += 1;
    return { score: total, positions: positions };
}

// The text as HTML, matched characters wrapped in <mark>.
export function highlight(target, positions) {
    var text = target.text;
    if (!positions || !positions.length) return escapeHtml(text);
    var hit = {};
    for (var i = 0; i < positions.length; i++) {
        var j = positions[i];
        hit[target.map ? target.map[j] : j] = true;
    }
    var out = '', open = false;
    for (var c = 0; c < text.length; c++) {
        var on = !!hit[c];
        if (on !== open) { out += on ? '<mark>' : '</mark>'; open = on; }
        out += escapeHtml(text[c]);
    }
    return out + (open ? '</mark>' : '');
}
