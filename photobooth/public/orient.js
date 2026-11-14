// Which way is "up" for the camera frame?
//
// W3C DeviceOrientation Euler angles (beta = about x, gamma = about y) go
// degenerate near upright-landscape (an iPad standing on its case), so reading
// them separately misfires. Instead rebuild the gravity direction in device
// coordinates — R = Rz(α)·Rx(β)·Ry(γ), so world-down in device space is
// (cosβ·sinγ, −sinβ, −cosβ·cosγ) — and take its angle in the screen plane.

const RAD = Math.PI / 180;

/**
 * Device rotation (clockwise degrees from upright portrait, snapped to
 * 0/90/180/270) from deviceorientation beta/gamma, or null when the device
 * is lying too flat to tell.
 */
export function deviceRotation(beta, gamma) {
  const cb = Math.cos(beta * RAD), sb = Math.sin(beta * RAD), sg = Math.sin(gamma * RAD);
  // World-up projected on the screen (x right, y up): u = (−cosβ·sinγ, sinβ).
  const ux = -cb * sg, uy = sb;
  if (Math.hypot(ux, uy) < 0.35) return null;           // flat on a table
  const deg = (Math.atan2(-ux, uy) / RAD + 360) % 360;   // CW from screen-up
  return (Math.round(deg / 90) * 90) % 360;
}

/**
 * Clockwise degrees to rotate a screen-space camera frame so the world's up
 * is up. Camera frames arrive rotated to match the page's interface
 * orientation, so if the page's layout orientation (portrait/landscape)
 * already matches the device's, no correction is needed. We deliberately
 * don't trust screen.orientation.angle there: iPad Safari (desktop-class
 * browsing) can report landscape as 0°. Only an orientation-locked page with
 * a turned device needs rotating.
 *
 * tilt: {beta, gamma} | null; landscape: is the page laid out landscape;
 * screenAngle: screen.orientation.angle (only used for a locked-landscape page).
 */
export function uprightRotation(tilt, landscape = false, screenAngle = 0) {
  if (!tilt) return 0;   // no sensor access: browser-rotated frames are upright
  const dev = deviceRotation(tilt.beta, tilt.gamma);
  if (dev === null) return 0;
  const devLandscape = dev % 180 !== 0;
  if (devLandscape === landscape) return 0;
  // Page locked portrait, device turned: rotate by the device turn.
  if (!landscape) return dev;
  // Page locked landscape (rare), device upright: undo the page's turn.
  const page = screenAngle % 180 !== 0 ? screenAngle : 90;
  return ((dev - page) % 360 + 360) % 360;
}
