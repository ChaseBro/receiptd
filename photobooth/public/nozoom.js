// No pinch / double-tap zoom on iOS Safari + Home Screen apps. Loaded as a
// classic <script> in <head> so it's active before anything else runs (iOS
// ignores user-scalable=no and only partly honors touch-action). Layers:
//  1. cancel the touch the moment a second finger lands (stops the pinch
//     before WebKit's gesture recognizer starts; single taps unaffected),
//  2. cancel any multi-finger / scaled touchmove,
//  3. cancel Safari's proprietary gesture events,
//  4. block double-tap-to-zoom on fast repeat taps of non-buttons.
// None of this applies while the page is already zoomed in, so it can always
// be pinched back out to 100%.
(function () {
  var opts = { passive: false, capture: true };
  // Already zoomed in (e.g. a pinch that slipped through, or a zoom Safari
  // restored on reload)? Then let gestures through so it can be pinched back
  // out — blocking here would trap the page zoomed in. At 100% we block again.
  function zoomed() { var vv = window.visualViewport; return !!vv && vv.scale > 1.02; }
  function stop(e) { if (e.cancelable && !zoomed()) e.preventDefault(); }
  document.addEventListener("touchstart", function (e) { if (e.touches.length > 1) stop(e); }, opts);
  document.addEventListener("touchmove", function (e) {
    if (e.touches.length > 1 || (typeof e.scale === "number" && e.scale !== 1)) stop(e);
  }, opts);
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (t) { document.addEventListener(t, stop, opts); });
  var last = 0;
  document.addEventListener("touchend", function (e) {
    var now = Date.now(), t = e.target;
    var tappable = t && t.closest && t.closest("button, a, input, label, select, textarea");
    if (!tappable && now - last < 350) stop(e);
    last = now;
  }, opts);
})();
