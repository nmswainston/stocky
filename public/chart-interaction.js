// Shared wheel and touch behavior for every chart on the dashboard.
// The page owns the mouse wheel and vertical touch drags; the chart
// keeps pressed-mouse panning, horizontal touch panning, pinch zoom
// and axis dragging. Without this, a tall chart traps page scrolling:
// the wheel zooms the chart instead of moving the page, and a vertical
// swipe on a phone pans the chart instead of scrolling.

export const PAGE_FRIENDLY_INTERACTION = {
  handleScroll: {
    mouseWheel: false,
    pressedMouseMove: true,
    horzTouchDrag: true,
    vertTouchDrag: false,
  },
  handleScale: {
    mouseWheel: false,
    pinch: true,
    axisPressedMouseMove: true,
  },
};
