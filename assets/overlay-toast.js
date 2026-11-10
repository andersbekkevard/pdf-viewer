// Toast: one short line of feedback for an action that otherwise shows
// nothing (a copy, a mark, a jump back, a failed rename). A new message
// replaces the current one. `aria-live` announces it to assistive tech.
export function createToast(core) {
    var document = core.document;
    var window = core.window;

    var node = null;
    var timer = null;

    // show('Copied page 12') or show('Could not rename', { error: true }).
    function show(message, options) {
        if (!message || !document.body) return;
        if (!node) {
            node = document.createElement('div');
            node.id = 'pdf2html-toast';
            node.setAttribute('role', 'status');
            node.setAttribute('aria-live', 'polite');
        }
        if (!node.isConnected) document.body.appendChild(node);
        node.textContent = String(message);
        node.classList.toggle('error', !!(options && options.error));
        // Restart the entrance transition for a replacing message.
        node.classList.remove('shown');
        void node.offsetWidth;
        node.classList.add('shown');
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(function () {
            timer = null;
            node.classList.remove('shown');
        }, options && options.error ? 3200 : 1800);
    }

    return { show: show };
}
