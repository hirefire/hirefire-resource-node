const Probe = require("../src/probe")

describe("Probe", () => {
  test("start returns a probe", () => {
    const probe = Probe.start()
    expect(probe).toBeInstanceOf(Probe)
  })

  test("finish empty ops", () => {
    const probe = Probe.start()
    const payload = probe.finish()

    expect(typeof payload.wave_ms).toBe("number")
    expect(payload.wave_ms).toBeGreaterThanOrEqual(0)
    expect(payload.ops).toEqual([])
  })

  test("record builds op shape", () => {
    const probe = Probe.start()
    probe.record(
      {
        adapter: "bullmq",
        strategy: "jql",
        queues: ["default", "mailers"],
        options: { schema: "public" },
      },
      12.3456,
    )
    const payload = probe.finish()

    expect(payload.ops).toHaveLength(1)
    const op = payload.ops[0]
    expect(op.adapter).toBe("bullmq")
    expect(op.strategy).toBe("jql")
    expect(op.queues).toEqual(["default", "mailers"])
    expect(op.options).toEqual({ schema: "public" })
    expect(op.ms).toBe(12.346)
  })

  test("record normalizes missing and wrong type fields", () => {
    const probe = Probe.start()
    probe.record(
      {
        adapter: null,
        strategy: "jqs",
        queues: "default",
        options: ["x"],
      },
      1.0,
    )
    const op = probe.finish().ops[0]

    expect(op.adapter).toBeNull()
    expect(op.strategy).toBe("jqs")
    expect(op.queues).toEqual([])
    expect(op.options).toEqual({})
    expect(op.ms).toBe(1)
  })

  test("record null strategy is empty string", () => {
    const probe = Probe.start()
    probe.record({ adapter: "a", strategy: null }, 0.5)
    probe.record({ adapter: "a" }, 0.5)
    expect(probe.finish().ops[0].strategy).toBe("")
    expect(probe.finish().ops[1].strategy).toBe("")
  })

  test("record non hash entry coerces", () => {
    const probe = Probe.start()
    probe.record(null, 2.0)
    probe.record("bad", 3.0)
    probe.record([1], 4.0)
    const ops = probe.finish().ops

    expect(ops).toHaveLength(3)
    for (const op of ops) {
      expect(op.adapter).toBeNull()
      expect(op.strategy).toBe("")
      expect(op.queues).toEqual([])
      expect(op.options).toEqual({})
    }
    expect(ops[0].ms).toBe(2)
    expect(ops[1].ms).toBe(3)
    expect(ops[2].ms).toBe(4)
  })

  test("measure times function and records", async () => {
    const probe = Probe.start()
    let called = false
    const result = await probe.measure(
      { adapter: "a", strategy: "jql", queues: ["q"] },
      async () => {
        called = true
        await new Promise((r) => setTimeout(r, 15))
        return "ok"
      },
    )

    expect(called).toBe(true)
    expect(result).toBe("ok")
    const op = probe.finish().ops[0]
    expect(op.adapter).toBe("a")
    expect(op.strategy).toBe("jql")
    expect(op.queues).toEqual(["q"])
    expect(typeof op.ms).toBe("number")
    expect(op.ms).toBeGreaterThanOrEqual(5)
  })

  test("measure does not record when function raises", async () => {
    const probe = Probe.start()
    await expect(
      probe.measure({ strategy: "jql" }, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(probe.finish().ops).toEqual([])
  })

  test("measure keeps prior ops when later raises", async () => {
    const probe = Probe.start()
    await probe.measure({ strategy: "jql" }, async () => {})
    await expect(
      probe.measure({ strategy: "jqs" }, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    const payload = probe.finish()
    expect(payload.ops).toHaveLength(1)
    expect(payload.ops[0].strategy).toBe("jql")
    expect(typeof payload.wave_ms).toBe("number")
  })

  test("finish wave_ms covers all ops", async () => {
    const probe = Probe.start()
    await probe.measure({ strategy: "jql" }, async () => {
      await new Promise((r) => setTimeout(r, 15))
    })
    await probe.measure({ strategy: "jqs" }, async () => {
      await new Promise((r) => setTimeout(r, 15))
    })
    const payload = probe.finish()
    const opsMs = payload.ops.reduce((sum, op) => sum + op.ms, 0)

    expect(payload.ops).toHaveLength(2)
    for (const op of payload.ops) {
      expect(payload.wave_ms).toBeGreaterThanOrEqual(op.ms)
    }
    expect(payload.wave_ms + 1).toBeGreaterThanOrEqual(opsMs)
    expect(payload.wave_ms).toBeGreaterThanOrEqual(10)
  })

  test("finish is stable when called twice", () => {
    const probe = Probe.start()
    probe.record({ strategy: "jql" }, 3.0)
    const first = probe.finish()
    const second = probe.finish()

    expect(first).toBe(second)
    expect(first.wave_ms).toBe(second.wave_ms)
  })

  test("finish ops isolated from later record", async () => {
    const probe = Probe.start()
    probe.record({ strategy: "jql" }, 1.0)
    const first = probe.finish()
    const firstWaveMs = first.wave_ms
    const firstOps = first.ops

    await new Promise((r) => setTimeout(r, 15))
    probe.record({ strategy: "jqs" }, 2.0)
    const second = probe.finish()

    expect(firstOps).toHaveLength(1)
    expect(firstOps[0].strategy).toBe("jql")
    expect(first.wave_ms).toBe(firstWaveMs)
    expect(second.ops).toHaveLength(2)
    expect(first).not.toBe(second)
    expect(second.wave_ms).toBeGreaterThanOrEqual(firstWaveMs)
  })

  test("log writes wave and per op lines", () => {
    const lines = []
    const logger = {
      info(msg) {
        lines.push(msg)
      },
    }
    const probe = Probe.start()
    probe.record(
      { adapter: "bullmq", strategy: "jql", queues: ["default"] },
      4.5,
    )
    probe.logTo(logger)

    const text = lines.join("\n")
    expect(text).toContain("sample_job_queues wave_ms=")
    expect(text).toContain("ops=1")
    expect(text).toContain('sample adapter="bullmq" strategy=jql')
    expect(text).toContain("queues=default")
    expect(text).toContain("ms=4.5")
  })
})
