class Transformation2D {
  constructor () {
    this.setZero()
  }

  setZero () {
    this.xx = 0.0
    this.xy = 0.0
    this.xd = 0.0
    this.yx = 0.0
    this.yy = 0.0
    this.yd = 0.0
  }

  scale (x, y) {
    this.xx *= x
    this.xy *= x
    this.xd *= x
    this.yx *= y
    this.yy *= y
    this.yd *= y
  };

  setScale (x, y) {
    this.xx = x
    this.xy = 0.0
    this.xd = 0.0
    this.yx = 0.0
    this.yy = y
    this.yd = 0.0
  };

  setShift (x, y) {
    this.xx = 1.0
    this.xy = 0.0
    this.xd = x
    this.yx = 0.0
    this.yy = 1.0
    this.yd = y
  };
}

function transformX (x, y, transform) {
  return transform.xx * x + transform.xy * y + transform.xd
}

function transformY (x, y, transform) {
  return transform.yx * x + transform.yy * y + transform.yd
}

const quantizationUtils = {

  // keeping z and m transform params for future reference
  createTransform: (transformObj) => {
    const xScale = transformObj.scale.xScale
    const yScale = transformObj.scale.yScale
    // eslint-disable-next-line no-unused-vars
    const zScale = transformObj.scale.zScale
    // eslint-disable-next-line no-unused-vars
    const mScale = transformObj.scale.mScale

    const xTranslate = transformObj.translate.xTranslate
    const yTranslate = transformObj.translate.yTranslate
    // eslint-disable-next-line no-unused-vars
    const zTranslate = transformObj.translate.zTranslate
    // eslint-disable-next-line no-unused-vars
    const mTranslate = transformObj.translate.mTranslate

    const trans2D = new Transformation2D()
    trans2D.setShift(-xTranslate, -yTranslate)
    trans2D.scale(1.0 / xScale, 1.0 / yScale)

    return trans2D
  },

  createInverseTransform: (originalTransform) => {
    const inverse = new Transformation2D()

    let det = originalTransform.xx * originalTransform.yy - originalTransform.xy * originalTransform.yx

    if (det === 0.0) {
      inverse.setZero()
    } else {
      det = 1.0 / det
      const _xd = (originalTransform.xy * originalTransform.yd - originalTransform.xd * originalTransform.yy) * det
      const _yd = (originalTransform.xd * originalTransform.yx - originalTransform.xx * originalTransform.yd) * det
      const _xx = originalTransform.yy * det
      const _xy = -originalTransform.xy * det
      const _yx = -originalTransform.yx * det
      const _yy = originalTransform.xx * det
      inverse.xd = _xd
      inverse.yd = _yd
      inverse.xx = _xx
      inverse.yy = _yy
      inverse.xy = _xy
      inverse.yx = _yx
    }
    return inverse
  },

  transformPoint: (xyCoordArray, transform) => {
    const x = xyCoordArray[0]
    const y = xyCoordArray[1]

    const transformedCoords = [transformX(x, y, transform), transformY(x, y, transform)]
    return transformedCoords
  }

}

module.exports = quantizationUtils
