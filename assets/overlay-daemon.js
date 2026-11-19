// How the overlay reaches the daemon.
//
// The reader runs in two places. On the daemon's own origin
// (http://localhost:7435/r/<hash>/) every daemon path is a relative URL and
// the browser does the rest. At a PDF's own address (the extension builds the
// reader there, docs/in-place.md) the page belongs to another site: a relative
// URL would go to that site, the page may not call localhost, and its
// localStorage is that site's. There the extension's page script connects a
// transport that carries requests through the extension instead.
//
// Modules never build an absolute daemon URL or touch `location` to move
// between documents: they use this object.
//
//   embedded          true at a PDF's own address
//   fetch(url, init)  a daemon path → Response
//   storage           getItem/setItem/removeItem (preferences, local state)
//   query             the reader address's own query (`local`, `stamp`)
//   location, history  what overlay-navigation.js reads the requested page
//                     from (`hash`) and clears it through (`replaceState`)
//   image(url, signal)  embedded only: a daemon image → a blob: URL to show
//   release(src)      embedded only: free a blob: URL from image()
//   setImage(img, url)  show a daemon image in <img> (honours loading=lazy)
//   open(href, newTab)  go to another daemon address (a document, the library)
//   leave(url)        replace this tab with an address outside the reader
//   url(path)         the absolute address of a daemon path, for window.open
//   post(url, body)   fire-and-forget POST that survives the page closing
//   viewport(width, dpr)  remember the page width for the next open

function safeStorage() {
    try { return window.localStorage; } catch (_) { return null; }
}

var memory = {};
var fallbackStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
    setItem: function (k, v) { memory[k] = String(v); },
    removeItem: function (k) { delete memory[k]; },
};

export var daemon = {
    embedded: false,
    fetch: function (url, init) { return window.fetch(url, init); },
    storage: safeStorage() || fallbackStorage,
    query: new URLSearchParams(window.location.search),
    location: window.location,
    history: window.history,
    image: function (url) { return Promise.resolve(url); },
    release: function () {},
    setImage: function (img, url) { img.src = url; },
    open: function (href, newTab) {
        if (newTab) window.open(href, '_blank');
        else window.location.href = href;
    },
    leave: function (url) { window.location.replace(url); },
    url: function (path) { return path; },
    post: function (url, body) {
        if (!(navigator.sendBeacon && navigator.sendBeacon(url, body))) {
            window.fetch(url, { method: 'POST', body: body, keepalive: true }).catch(function () {});
        }
    },
    viewport: function (width, dpr) {
        // The daemon repeats the first-raster arithmetic from this cookie and
        // starts rendering (and preloading) that page image with the shell,
        // before any script has run (daemon/main.py, _first_raster).
        document.cookie = 'pdfv_vp=' + width + 'x' + dpr + '; path=/; max-age=31536000; samesite=lax';
    },
};

// Lazy images through a transport: fetched when they come near the viewport,
// as `loading=lazy` does for an ordinary source.
function lazyImages(transport) {
    var observer = null, wanted = new WeakMap();
    function load(img) {
        var url = wanted.get(img);
        if (!url) return;
        wanted.delete(img);
        transport.image(url).then(function (src) {
            var previous = img.getAttribute('src');
            img.addEventListener('load', function () {
                if (previous && previous.indexOf('blob:') === 0) transport.release(previous);
            }, { once: true });
            img.src = src;
        }, function () {});
    }
    return function setImage(img, url) {
        if (img.loading !== 'lazy' || !window.IntersectionObserver) { wanted.set(img, url); load(img); return; }
        if (!observer) {
            observer = new window.IntersectionObserver(function (changes) {
                changes.forEach(function (change) {
                    if (!change.isIntersecting) return;
                    observer.unobserve(change.target);
                    load(change.target);
                });
            }, { rootMargin: '600px 0px' });
        }
        // The browser must not also try the address itself.
        img.loading = 'eager';
        wanted.set(img, url);
        observer.observe(img);
    };
}

// Called once by the extension's page script, before overlay.js is imported.
export function connect(transport) {
    Object.assign(daemon, transport, { embedded: true });
    if (!transport.setImage) daemon.setImage = lazyImages(daemon);
}
