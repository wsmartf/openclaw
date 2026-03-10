import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(async () => "node-1"),
  listNodes: vi.fn(async () => [] as Array<{ nodeId: string; commands?: string[] }>),
  resolveNodeIdFromList: vi.fn(() => "node-1"),
}));

const screenMocks = vi.hoisted(() => ({
  parseScreenRecordPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "mp4",
    durationMs: 300_000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
  })),
  screenRecordTempPath: vi.fn(() => "/tmp/screen-record.mp4"),
  writeScreenRecordToFile: vi.fn(async () => ({ path: "/tmp/screen-record.mp4" })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: nodeUtilsMocks.resolveNodeId,
  listNodes: nodeUtilsMocks.listNodes,
  resolveNodeIdFromList: nodeUtilsMocks.resolveNodeIdFromList,
}));

vi.mock("../../cli/nodes-screen.js", () => ({
  parseScreenRecordPayload: screenMocks.parseScreenRecordPayload,
  screenRecordTempPath: screenMocks.screenRecordTempPath,
  writeScreenRecordToFile: screenMocks.writeScreenRecordToFile,
}));

import { createNodesTool } from "./nodes-tool.js";

describe("createNodesTool screen_record duration guardrails", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReturnValue({});
    nodeUtilsMocks.resolveNodeId.mockClear();
    screenMocks.parseScreenRecordPayload.mockClear();
    screenMocks.writeScreenRecordToFile.mockClear();
  });

  it("caps durationMs schema at 300000", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        durationMs?: {
          maximum?: number;
        };
      };
    };
    expect(schema.properties?.durationMs?.maximum).toBe(300_000);
  });

  it("clamps screen_record durationMs argument to 300000 before gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "screen_record",
      node: "macbook",
      durationMs: 900_000,
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        params: expect.objectContaining({
          durationMs: 300_000,
        }),
      }),
    );
  });

  it("omits rawCommand when preparing wrapped argv execution", async () => {
    nodeUtilsMocks.listNodes.mockResolvedValue([
      {
        nodeId: "node-1",
        commands: ["system.run"],
      },
    ]);
    gatewayMocks.callGatewayTool.mockImplementation(async (_method, _opts, payload) => {
      if (payload?.command === "system.run.prepare") {
        return {
          payload: {
            cmdText: "echo hi",
            plan: {
              argv: ["bash", "-lc", "echo hi"],
              cwd: null,
              rawCommand: null,
              agentId: null,
              sessionKey: null,
            },
          },
        };
      }
      if (payload?.command === "system.run") {
        return { payload: { ok: true } };
      }
      throw new Error(`unexpected command: ${String(payload?.command)}`);
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "run",
      node: "macbook",
      command: ["bash", "-lc", "echo hi"],
    });

    const prepareCall = gatewayMocks.callGatewayTool.mock.calls.find(
      (call) => call[2]?.command === "system.run.prepare",
    )?.[2];
    expect(prepareCall).toBeTruthy();
    expect(prepareCall?.params).toMatchObject({
      command: ["bash", "-lc", "echo hi"],
      agentId: "main",
    });
    expect(prepareCall?.params).not.toHaveProperty("rawCommand");
  });

  it("uses two-phase exec approvals for node run retries", async () => {
    nodeUtilsMocks.listNodes.mockResolvedValue([
      {
        nodeId: "node-1",
        commands: ["system.run"],
      },
    ]);
    gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, payload, extra) => {
      if (method === "node.invoke" && payload?.command === "system.run.prepare") {
        return {
          payload: {
            cmdText: "echo hi",
            plan: {
              argv: ["bash", "-lc", "echo hi"],
              cwd: null,
              rawCommand: null,
              agentId: null,
              sessionKey: null,
            },
          },
        };
      }
      if (
        method === "node.invoke" &&
        payload?.command === "system.run" &&
        !payload?.params?.runId
      ) {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        expect(payload).toMatchObject({
          id: expect.any(String),
          command: "echo hi",
          commandArgv: ["bash", "-lc", "echo hi"],
          host: "node",
          nodeId: "node-1",
          twoPhase: true,
        });
        expect(extra).toEqual({ expectFinal: false });
        return {
          id: "approval-1",
          status: "accepted",
        };
      }
      if (method === "exec.approval.waitDecision") {
        expect(payload).toEqual({ id: "approval-1" });
        return { decision: "allow-always" };
      }
      if (method === "node.invoke" && payload?.command === "system.run") {
        expect(payload?.params).toMatchObject({
          runId: "approval-1",
          approved: true,
          approvalDecision: "allow-always",
        });
        return { payload: { ok: true } };
      }
      throw new Error(`unexpected call: ${String(method)}`);
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "run",
      node: "macbook",
      command: ["bash", "-lc", "echo hi"],
    });
  });

  it("surfaces approval timeout when waitDecision expires", async () => {
    nodeUtilsMocks.listNodes.mockResolvedValue([
      {
        nodeId: "node-1",
        commands: ["system.run"],
      },
    ]);
    gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, payload, extra) => {
      if (method === "node.invoke" && payload?.command === "system.run.prepare") {
        return {
          payload: {
            cmdText: "echo hi",
            plan: {
              argv: ["bash", "-lc", "echo hi"],
              cwd: null,
              rawCommand: null,
              agentId: null,
              sessionKey: null,
            },
          },
        };
      }
      if (
        method === "node.invoke" &&
        payload?.command === "system.run" &&
        !payload?.params?.runId
      ) {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        expect(extra).toEqual({ expectFinal: false });
        return {
          id: "approval-timeout",
          status: "accepted",
        };
      }
      if (method === "exec.approval.waitDecision") {
        throw new Error("approval expired or not found");
      }
      throw new Error(`unexpected call: ${String(method)}`);
    });
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "run",
        node: "macbook",
        command: ["bash", "-lc", "echo hi"],
      }),
    ).rejects.toThrow("exec denied: approval timed out");

    const approvedRetryCall = gatewayMocks.callGatewayTool.mock.calls.find(
      (call) => call[0] === "node.invoke" && call[2]?.params?.runId === "approval-timeout",
    );
    expect(approvedRetryCall).toBeUndefined();
  });
});
