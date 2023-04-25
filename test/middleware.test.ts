import { PLATFORM, TOKEN, setup, travel } from "./helpers";
import { Agent } from "../src/agent";
import { handle } from "../src/middleware";

beforeEach(setup);

test("default", async () => {
  const agent = new Agent(PLATFORM);
  const params = await handle(agent, { method: "GET", path: "/" });
  expect(params).toBe(null);
});

test("serve", async () => {
  const agent = new Agent(PLATFORM).serve(
    TOKEN,
    async () => 1.23
  );
  const data = await handle(agent, {
    method: "GET",
    path: "/autoscale",
    tokens: `${TOKEN},invalid`,
  });
  expect(data).toStrictEqual({
    headers: {
      "Content-Length": "4",
      "Content-Type": "application/json",
      "Cache-Control": "must-revalidate, private, max-age=0",
    },
    status: 200,
    body: "1.23",
  });
});

test("serve 404", async () => {
  const agent = new Agent(PLATFORM).serve(
    TOKEN,
    async () => 1.23
  );
  const data = await handle(agent, {
    method: "GET",
    path: "/autoscale",
    tokens: `invalid`,
  });
  expect(data).toStrictEqual({
    headers: {},
    status: 404,
    body: "can't find token-associated worker server",
  });
});

test("call record queue time on render", async () => {
  const agent = new Agent("render").dispatch(TOKEN);
  const dispatcher = agent.webDispatcher!;
  const runSpy = jest.spyOn(dispatcher, "run").mockImplementation(undefined)
  for (const [distance, start] of [
    [0, 500_000],
    [0, 1_000_000],
    [1000, 1_500_000],
  ]) {
    travel(distance as number);
    expect(
      await handle(agent, {
        method: "GET",
        path: "/",
        start: String(Date.now() * 1000 - Number(start)),
      })
    ).toBe(null);
  }
  expect(dispatcher["buffer"]).toStrictEqual(
    new Map(
      Object.entries({
        "946684800": 1000,
        "946684801": 1500,
      })
    )
  );
  expect(runSpy).toHaveBeenCalled();
});
