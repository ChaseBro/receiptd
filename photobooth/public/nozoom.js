// No pinch / double-tap zoom on iOS Safari + Home Screen apps. Loaded as a
// classic <script> in <head> so it's active before anything else runs (iOS
// ignores user-scalable=no and only partly honors touch-action). Layers:
//  1. cancel the touch the moment a second finger lands (stops the pinch
//     before WebKit's gesture recognizer starts; single taps unaffected),
//  2. cancel any multi-finger / scaled touchmove,
//  3. cancel Safari's proprietary gesture events,
//  4. block double-tap-to-zoom on fast repeat taps of non-buttons.
(function () {
  var opts = { passive: false, capture: true };
  function stop(e) { if (e.cancelable) e.preventDefault(); }
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
