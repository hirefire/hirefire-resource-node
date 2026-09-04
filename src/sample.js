function validSample(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function coerceSample(value) {
  return Number(value)
}

function formatSampleValue(value) {
  try {
    const text = value === null ? "null" : typeof value
    let preview = String(value)
    if (Buffer.byteLength(preview) > 64) {
      preview = preview.slice(0, 64) + "…"
    }
    return `${text}(${JSON.stringify(preview)})`
  } catch {
    return typeof value
  }
}

module.exports = { validSample, coerceSample, formatSampleValue }
