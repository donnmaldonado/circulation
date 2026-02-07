// TripsLayer that skips segments outside the visible time window in the
// *vertex* shader. Stock TripsLayer rasterises every segment of every trip and
// discards per fragment. At any moment only a few percent of segments sit inside
// [currentTime − trailLength, currentTime], so collapsing the rest before
// rasterisation (and before PathLayer's miter/projection maths) saves most of
// the frame. Output is identical; this is purely a perf change.

import { TripsLayer } from '@deck.gl/geo-layers';

const CULL_GLSL = `\
if (instanceNextTimestamps < trips.currentTime - trips.trailLength || instanceTimestamps > trips.currentTime) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume: the segment is dropped
  return;
}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class CulledTripsLayer<D = any> extends TripsLayer<D> {
  static layerName = 'CulledTripsLayer';

  getShaders() {
    const shaders = super.getShaders();
    if (this.context.device.type !== 'webgpu') {
      shaders.inject = { ...shaders.inject, 'vs:#main-start': CULL_GLSL };
    }
    return shaders;
  }
}
