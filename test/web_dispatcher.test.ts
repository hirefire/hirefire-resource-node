import nock from "nock";
import { CONSOLE, TOKEN, setup, travel } from "./helpers";
import { WebDispatcher } from "../src/web_dispatcher";

beforeEach(setup);

test("id", () => {
  const dispatcher = new WebDispatcher(TOKEN);
  expect(dispatcher.id).toBe("u4quBFg");
});

test("dispatch", async () => {
  const dispatcher = new WebDispatcher(TOKEN);
  const metrics = [[1], [0, 2, 1], [2, 1, 3], [1, 4, 3], [5, 4, 1], [6, 2, 6], [0, 3, 7]];
  for (const i in metrics) {
    travel(1000)
    for (const metric of metrics[i] as number[]) {
      await dispatcher.add(metric)
    }
  }
  const request = nock("https://metrics.autoscale.app", {
    reqheaders: {
      "user-agent": "Autoscale Agent (Node)",
      "content-type": "application/json",
      "content-length": "85",
      "autoscale-metric-token": "u4quBFgM72qun74EwashWv6Ll5TzhBVktVmicoWoXla",
    },
  })
    .post("/", {
      "946684801": 1,
      "946684802": 2,
      "946684803": 3,
      "946684804": 4,
      "946684805": 5,
      "946684806": 6,
    })
    .reply(200, "");
  await dispatcher.dispatch();
  expect(request.isDone()).toBe(true);
  expect(dispatcher["buffer"]).toStrictEqual(new Map([["946684807", 7]]));
});

test("dispatch 500", async () => {
  const dispatcher = new WebDispatcher(TOKEN);
  const request = nock("https://metrics.autoscale.app").post("/").reply(500, "");
  await dispatcher.add(1);
  travel(1000)
  await dispatcher.dispatch();
  expect(request.isDone()).toBe(true);
  expect(dispatcher["buffer"]).toStrictEqual(
    new Map(Object.entries({ "946684800": 1 }))
  );
  expect(CONSOLE).toHaveBeenCalledWith(
    "WebDispatcher[u4quBFg]: Failed to dispatch"
  );
});

test("prune", async () => {
  const dispatcher = new WebDispatcher(TOKEN);
  await dispatcher.add(1);
  travel(30_000)
  await dispatcher.add(1);
  travel(10_000)
  await dispatcher.prune();
  expect(dispatcher["buffer"]).toStrictEqual(
    new Map(Object.entries({ "946684830": 1 }))
  );
});
