---
id: mcp/write-tests-for-task
version: 1
description: The MCP write-tests-for-task prompt. Asks an engineer's own agent for tests proving a task's acceptance criteria, before the implementation.
inputs: [task, taskKey]
---
Write the tests that prove the task below is done, before any implementation
exists.

- Write one test per acceptance criterion, and one behaviour per test. If a
  test's name needs "and", split it into two tests.
- Name every test after the task, starting with {{taskKey}}, so the tests that
  prove it can be found and run together.
- Structure each test as Given, When, Then, mirroring the criterion it proves.
- Test through the outside of the system first: the API, the UI or the tool
  that a user or agent actually calls. Add narrower tests only where the
  outside test cannot reach.
- Assert on what a user can observe, never on private functions or on how many
  times a mock was called.
- Run the tests and confirm each one fails for the right reason, meaning the
  failure describes the missing behaviour, not a typo or a missing import.
  Report that failure output.

The task:

{{task}}
