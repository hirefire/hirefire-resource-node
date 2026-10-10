const Once = require("./once")
const Plan = require("./plan")
const Entry = require("./plan/entry")
const Probe = require("./probe")
const sampleRound = require("./sample_round")
const safeLog = require("./log")
const { formatError, verbose } = safeLog
const { validSample, formatSampleValue } = require("./sample")
const { WRK } = require("./strategy")

class Sampler {
  constructor(configuration) {
    this._configuration = configuration
    this._once = new Once(configuration)
  }

  canSample(plan) {
    return (
      this._configuration.jobQueues.any() ||
      plan.some((raw) => new Entry(raw).sampleable)
    )
  }

  async round(plan, live) {
    const probe = Probe.start()
    await sampleRound.run(new Map(), async () => {
      for (const raw of plan) {
        if (!live()) break

        await probe.measure(raw, () => this._sample(raw, live))
      }
    })
    if (verbose()) probe.logTo(this._configuration.logger)
    return probe.finish()
  }

  async _sample(raw, live) {
    try {
      const entry = new Entry(raw)
      if (entry.problem) {
        this._once.log(
          "error",
          entry.problem,
          entry.key,
          `[HireFire] ${entry.problemMessage}`,
        )
      } else if (entry.local) {
        await this._sampleLocal(entry, live)
      } else {
        await this._sampleAdapter(entry, live)
      }
    } catch (error) {
      this._log(
        "error",
        `Plan sampler for ${JSON.stringify(raw.name)} raised ${formatError(
          error,
        )}`,
      )
    }
  }

  async _sampleLocal(entry, live) {
    const jobQueues = this._configuration.jobQueues
    const jobQueue = jobQueues.findByName(entry.name)
    if (jobQueue) {
      await this._record("The sampler", entry.name, entry.strategy, live, () =>
        jobQueue.sample(),
      )
    } else if (jobQueues.any()) {
      this._once.log(
        "warn",
        "no_local_sampler",
        entry.name,
        `[HireFire] No config.dyno sampler is named ${JSON.stringify(
          entry.name,
        )}, so this process samples nothing for it. Check the name, ` +
          "or select an adapter for it in the HireFire UI.",
      )
    }
  }

  async _sampleAdapter(entry, live) {
    const name = JSON.stringify(entry.name)
    if (this._configuration.jobQueues.findByName(entry.name)) {
      this._once.log(
        "warn",
        "plan_override",
        entry.name,
        `[HireFire] A HireFire UI adapter is configured for ${name}, so ` +
          `config.dyno(${name}) with a local sampler is ignored. You can ` +
          "remove that local configuration. The UI adapter is used instead.",
      )
    }
    if (entry.truncated) {
      this._once.log(
        "error",
        "queues_truncated",
        entry.name,
        `[HireFire] Plan queue list for ${name} truncated to ${Plan.MAX_QUEUES} names.`,
      )
    }

    await this._record("Plan sampler", entry.name, entry.strategy, live, () =>
      entry.call(),
    )
    if (entry.working) {
      await this._record("Plan working sampler", entry.name, WRK, live, () =>
        entry.callWorking(),
      )
    }
  }

  async _record(label, name, strategy, live, sample) {
    try {
      const value = await sample()
      if (!live()) return

      if (validSample(value)) {
        this._configuration.buffer.sample(name, strategy, value)
      } else {
        this._log(
          "error",
          `${label} for ${JSON.stringify(name)} returned ` +
            `${formatSampleValue(value)}, expected a non-negative number. ` +
            "Sample dropped.",
        )
      }
    } catch (error) {
      this._log(
        "error",
        `${label} for ${JSON.stringify(name)} raised ${formatError(error)}`,
      )
    }
  }

  _log(level, message) {
    safeLog(this._configuration.logger, level, `[HireFire] ${message}`)
  }
}

module.exports = Sampler
