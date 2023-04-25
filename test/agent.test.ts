import { TOKEN } from "./helpers";
import { Agent } from "../src/agent";
import { WebDispatcher } from "../src/web_dispatcher";
import { WorkerDispatcher } from "../src/worker_dispatcher";

const PLATFORM = "render";

test("supported platform", () => {
  for (const platform of ["render"]) {
    const agent = new Agent(platform);
    expect(agent.platform).toBe(platform);
  }
});

test("unsupported platform", () => {
  expect(() => new Agent("unsupported")).toThrow(
    'platform "unsupported" is unsupported, ' +
    '"render" is currently the only valid option'
  );
});

test("dispatch web", () => {
  const agent = new Agent(PLATFORM).dispatch(TOKEN);
  const dispatcher = agent.webDispatchers.queueTime;
  expect(dispatcher).toBeInstanceOf(WebDispatcher);
  expect(agent.webDispatchers["dispatchers"].length).toBe(1);
});

test("dispatch worker", () => {
  const agent = new Agent(PLATFORM).dispatch(
    TOKEN,
    async () => 1.23
  );
  const dispatcher = agent.workerDispatchers["dispatchers"][0];
  expect(dispatcher).toBeInstanceOf(WorkerDispatcher);
  expect(agent.workerDispatchers["dispatchers"].length).toBe(1);
});

test("serve worker", () => {
  const agent = new Agent(PLATFORM).dispatch(
    TOKEN,
    async () => 1.23
  );
  const dispatcher = agent.workerDispatchers["dispatchers"][0];
  expect(dispatcher).toBeInstanceOf(WorkerDispatcher);
  expect(agent.workerDispatchers["dispatchers"].length).toBe(1);
});
