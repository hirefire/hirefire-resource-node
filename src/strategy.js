const RQT = "rqt"

function rqt(strategy) {
  return String(strategy) === RQT
}

module.exports = { RQT, rqt }
