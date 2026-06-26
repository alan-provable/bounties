import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import {
  ApplicationError,
  useApplyForSlot,
  useApplyToBounty,
  useApproveApplicationSubmission,
  useDeclineApplicant,
  useRaiseDispute,
  useReleasePayment,
  useRemoveContributor,
  useRequestRevisions,
  useSelectApplicant,
} from "../use-bounty-application";
import { bountyKeys } from "@/lib/query/query-keys";
import { fetcher } from "@/lib/graphql/client";
import { post } from "@/lib/api/client";
import { EscrowService } from "@/lib/services/escrow";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("@/lib/query/query-keys", () => ({
  bountyKeys: {
    detail: (id: string) => ["Bounty", { id }],
    lists: () => ["Bounties"],
  },
}));

jest.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: {
          id: "user-1",
          name: "Ada",
          image: "https://example.com/avatar.png",
        },
      },
    }),
  },
}));

jest.mock("@/lib/graphql/client", () => ({
  fetcher: jest.fn(),
}));

jest.mock("@/lib/api/client", () => ({
  post: jest.fn(),
}));

jest.mock("@/lib/services/escrow", () => ({
  EscrowService: {
    releasePayment: jest.fn(),
  },
}));

const mockFetcher = fetcher as jest.MockedFunction<typeof fetcher>;
const mockPost = post as jest.MockedFunction<typeof post>;
const mockReleasePayment = EscrowService.releasePayment as jest.MockedFunction<
  typeof EscrowService.releasePayment
>;

type TestBounty = {
  id: string;
  status: string;
  updatedAt: string;
  rewardAmount: number;
  totalSlotsOccupied?: number;
  contributorProgress?: Array<{
    userId: string;
    userName: string;
    userAvatarUrl: string;
    currentMilestoneId: string;
  }>;
  milestones?: Array<{ id: string; title: string }>;
  applications?: Array<{
    id: string;
    applicantAddress: string;
    status: string;
  }>;
};

const bountyId = "42";
const detailKey = bountyKeys.detail(bountyId);

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function seedBounty(
  queryClient: QueryClient,
  bounty: Partial<TestBounty> = {},
) {
  const seeded = {
    bounty: {
      id: bountyId,
      status: "OPEN",
      updatedAt: "2026-01-01T00:00:00.000Z",
      rewardAmount: 120,
      ...bounty,
    },
  };
  queryClient.setQueryData(detailKey, seeded);
  return seeded;
}

function getBounty(queryClient: QueryClient): TestBounty {
  return queryClient.getQueryData<{ bounty: TestBounty }>(detailKey)!.bounty;
}

async function expectStatusRollback(
  useHook: () => ReturnType<typeof useSelectApplicant>,
  mutateVariables: Record<string, unknown>,
  makeFail: () => void,
) {
  const queryClient = createQueryClient();
  const previous = seedBounty(queryClient);
  makeFail();

  const { result } = renderHook(() => useHook(), {
    wrapper: createWrapper(queryClient),
  });

  await act(async () => {
    await expect(
      result.current.mutateAsync(mutateVariables as never),
    ).rejects.toThrow();
  });

  expect(queryClient.getQueryData(detailKey)).toEqual(previous);
}

describe("use-bounty-application mutations", () => {
  const applicationClient = {
    apply: jest.fn(),
    selectApplicant: jest.fn(),
    submitWork: jest.fn(),
    approveSubmission: jest.fn(),
    applyForSlot: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    (
      globalThis as typeof globalThis & {
        __applicationContracts?: typeof applicationClient;
      }
    ).__applicationContracts = applicationClient;
    applicationClient.apply.mockResolvedValue({ txHash: "apply-tx" });
    applicationClient.selectApplicant.mockResolvedValue({
      txHash: "select-tx",
    });
    applicationClient.approveSubmission.mockResolvedValue({
      txHash: "approve-tx",
    });
    applicationClient.applyForSlot.mockResolvedValue({ txHash: "slot-tx" });
    mockFetcher.mockReturnValue(
      jest
        .fn()
        .mockResolvedValue({ reviewSubmission: { id: "sub-1" } }) as never,
    );
    mockPost.mockResolvedValue({
      id: "dispute-1",
      campaignId: bountyId,
      reason: "OTHER",
      description: "Needs review",
      status: "OPEN",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    mockReleasePayment.mockResolvedValue({
      poolId: bountyId,
      totalAmount: 120,
      asset: "USDC",
      isLocked: true,
      expiry: null,
      releasedAmount: 60,
      status: "Partially Released",
    } as never);
  });

  afterEach(() => {
    delete (
      globalThis as typeof globalThis & {
        __applicationContracts?: typeof applicationClient;
      }
    ).__applicationContracts;
  });

  it("applies to a bounty through the application contract", async () => {
    const queryClient = createQueryClient();
    const { result } = renderHook(() => useApplyToBounty(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        bountyId,
        applicantAddress: "GAPPLICANT",
        proposal: "I can cover the tests.",
      });
    });

    expect(applicationClient.apply).toHaveBeenCalledWith({
      applicant: "GAPPLICANT",
      bountyId: 42n,
      proposal: "I can cover the tests.",
    });
  });

  it("propagates apply contract errors", async () => {
    const queryClient = createQueryClient();
    applicationClient.apply.mockRejectedValueOnce(new Error("tx failed"));
    const { result } = renderHook(() => useApplyToBounty(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          bountyId,
          applicantAddress: "GAPPLICANT",
          proposal: "I can cover the tests.",
        }),
      ).rejects.toThrow("tx failed");
    });

    expect(applicationClient.apply).toHaveBeenCalledWith({
      applicant: "GAPPLICANT",
      bountyId: 42n,
      proposal: "I can cover the tests.",
    });
  });

  it("rejects an apply mutation with a missing wallet address", async () => {
    const queryClient = createQueryClient();
    const { result } = renderHook(() => useApplyToBounty(), {
      wrapper: createWrapper(queryClient),
    });

    await expect(
      result.current.mutateAsync({
        bountyId,
        applicantAddress: " ",
        proposal: "I can cover the tests.",
      }),
    ).rejects.toMatchObject<ApplicationError>({
      code: "tx_failed",
      message: "Applicant wallet address is required.",
    });
    expect(applicationClient.apply).not.toHaveBeenCalled();
  });

  it("optimistically marks a selected applicant bounty as in progress", async () => {
    const queryClient = createQueryClient();
    seedBounty(queryClient);
    const { result } = renderHook(() => useSelectApplicant(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        bountyId,
        creatorAddress: "GCREATOR",
        applicantAddress: "GAPPLICANT",
      });
    });

    expect(applicationClient.selectApplicant).toHaveBeenCalledWith({
      creator: "GCREATOR",
      bountyId: 42n,
      applicant: "GAPPLICANT",
    });
    expect(getBounty(queryClient).status).toBe("IN_PROGRESS");
  });

  it("rolls back selected applicant optimism on contract error", async () => {
    await expectStatusRollback(
      useSelectApplicant,
      { bountyId, creatorAddress: "GCREATOR", applicantAddress: "GAPPLICANT" },
      () =>
        applicationClient.selectApplicant.mockRejectedValueOnce(
          new Error("tx failed"),
        ),
    );
  });

  it("optimistically marks an approved submission bounty as completed", async () => {
    const queryClient = createQueryClient();
    seedBounty(queryClient);
    const { result } = renderHook(() => useApproveApplicationSubmission(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        bountyId,
        creatorAddress: "GCREATOR",
        points: 100,
      });
    });

    expect(applicationClient.approveSubmission).toHaveBeenCalledWith({
      creator: "GCREATOR",
      bountyId: 42n,
      points: 100,
    });
    expect(getBounty(queryClient).status).toBe("COMPLETED");
  });

  it("rolls back approved submission optimism on contract error", async () => {
    await expectStatusRollback(
      useApproveApplicationSubmission as never,
      { bountyId, creatorAddress: "GCREATOR", points: 100 },
      () =>
        applicationClient.approveSubmission.mockRejectedValueOnce(
          new Error("tx failed"),
        ),
    );
  });

  it("optimistically marks revision requests as under review", async () => {
    const queryClient = createQueryClient();
    seedBounty(queryClient);
    const { result } = renderHook(() => useRequestRevisions(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        bountyId,
        submissionId: "sub-1",
        feedback: "Please add rollback coverage.",
      });
    });

    expect(mockFetcher).toHaveBeenCalled();
    expect(getBounty(queryClient).status).toBe("UNDER_REVIEW");
  });

  it("rolls back revision request optimism on GraphQL error", async () => {
    const queryClient = createQueryClient();
    const previous = seedBounty(queryClient);
    mockFetcher.mockReturnValue(
      jest.fn().mockRejectedValue(new Error("request failed")) as never,
    );
    const { result } = renderHook(() => useRequestRevisions(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          bountyId,
          submissionId: "sub-1",
          feedback: "Please add rollback coverage.",
        }),
      ).rejects.toThrow();
    });

    expect(queryClient.getQueryData(detailKey)).toEqual(previous);
  });

  it("adds the current contributor when applying for a slot", async () => {
    const queryClient = createQueryClient();
    seedBounty(queryClient, {
      totalSlotsOccupied: 1,
      contributorProgress: [],
      milestones: [{ id: "m1", title: "Start" }],
    });
    const { result } = renderHook(() => useApplyForSlot(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        bountyId,
        applicantAddress: "GAPPLICANT",
      });
    });

    expect(applicationClient.applyForSlot).toHaveBeenCalledWith({
      applicant: "GAPPLICANT",
      bountyId: 42n,
    });
    expect(getBounty(queryClient).totalSlotsOccupied).toBe(2);
    expect(getBounty(queryClient).contributorProgress).toContainEqual({
      userId: "user-1",
      userName: "Ada",
      userAvatarUrl: "https://example.com/avatar.png",
      currentMilestoneId: "m1",
    });
  });

  it("rolls back slot application optimism on contract error", async () => {
    const queryClient = createQueryClient();
    const previous = seedBounty(queryClient, {
      totalSlotsOccupied: 1,
      contributorProgress: [],
      milestones: [{ id: "m1", title: "Start" }],
    });
    applicationClient.applyForSlot.mockRejectedValueOnce(
      new Error("tx failed"),
    );
    const { result } = renderHook(() => useApplyForSlot(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          bountyId,
          applicantAddress: "GAPPLICANT",
        }),
      ).rejects.toThrow();
    });

    expect(queryClient.getQueryData(detailKey)).toEqual(previous);
  });

  it("optimistically releases escrow pool funds", async () => {
    const queryClient = createQueryClient();
    seedBounty(queryClient, {
      rewardAmount: 120,
      milestones: [
        { id: "m1", title: "Start" },
        { id: "m2", title: "Finish" },
      ],
    });
    queryClient.setQueryData(["escrow", "pool", bountyId], {
      poolId: bountyId,
      totalAmount: 120,
      asset: "USDC",
      isLocked: true,
      expiry: null,
      releasedAmount: 0,
      status: "Escrowed",
    });
    const { result } = renderHook(() => useReleasePayment(bountyId), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        contributorId: "user-1",
        milestoneId: "m1",
      });
    });

    expect(mockReleasePayment).toHaveBeenCalledWith(bountyId, 60);
    expect(
      queryClient.getQueryData(["escrow", "pool", bountyId]),
    ).toMatchObject({
      releasedAmount: 60,
      status: "Partially Released",
    });
  });

  it("rolls back escrow release optimism on service error", async () => {
    const queryClient = createQueryClient();
    const previousPool = {
      poolId: bountyId,
      totalAmount: 120,
      asset: "USDC",
      isLocked: true,
      expiry: null,
      releasedAmount: 0,
      status: "Escrowed",
    };
    seedBounty(queryClient, {
      rewardAmount: 120,
      milestones: [
        { id: "m1", title: "Start" },
        { id: "m2", title: "Finish" },
      ],
    });
    queryClient.setQueryData(["escrow", "pool", bountyId], previousPool);
    mockReleasePayment.mockRejectedValueOnce(new Error("release failed"));
    const { result } = renderHook(() => useReleasePayment(bountyId), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          contributorId: "user-1",
          milestoneId: "m1",
        }),
      ).rejects.toThrow();
    });

    expect(queryClient.getQueryData(["escrow", "pool", bountyId])).toEqual(
      previousPool,
    );
  });

  it("removes a contributor and decrements occupied slots", async () => {
    const queryClient = createQueryClient();
    seedBounty(queryClient, {
      totalSlotsOccupied: 2,
      contributorProgress: [
        {
          userId: "user-1",
          userName: "Ada",
          userAvatarUrl: "a",
          currentMilestoneId: "m1",
        },
        {
          userId: "user-2",
          userName: "Grace",
          userAvatarUrl: "g",
          currentMilestoneId: "m1",
        },
      ],
    });
    const { result } = renderHook(() => useRemoveContributor(bountyId), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ contributorId: "user-1" });
    });

    expect(getBounty(queryClient).contributorProgress).toEqual([
      {
        userId: "user-2",
        userName: "Grace",
        userAvatarUrl: "g",
        currentMilestoneId: "m1",
      },
    ]);
    expect(getBounty(queryClient).totalSlotsOccupied).toBe(1);
  });

  it("declines an applicant by removing it from the applications list", async () => {
    const queryClient = createQueryClient();
    seedBounty(queryClient, {
      applications: [
        { id: "app-1", applicantAddress: "GAPPLICANT", status: "PENDING" },
        { id: "app-2", applicantAddress: "GOTHER", status: "PENDING" },
      ],
    });
    const { result } = renderHook(() => useDeclineApplicant(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        bountyId,
        applicantAddress: "GAPPLICANT",
        reason: "Out of scope",
      });
    });

    expect(getBounty(queryClient).applications).toEqual([
      { id: "app-2", applicantAddress: "GOTHER", status: "PENDING" },
    ]);
  });

  it("rolls back declined applicant optimism on mutation error", async () => {
    const queryClient = createQueryClient();
    const previous = seedBounty(queryClient, {
      applications: [
        { id: "app-1", applicantAddress: "GAPPLICANT", status: "PENDING" },
        { id: "app-2", applicantAddress: "GOTHER", status: "PENDING" },
      ],
    });
    let trimCalls = 0;
    const erroringReason = {
      trim: jest.fn(() => {
        trimCalls += 1;
        if (trimCalls === 1) return "Out of scope";
        throw new Error("decline failed");
      }),
    } as unknown as string;
    const { result } = renderHook(() => useDeclineApplicant(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          bountyId,
          applicantAddress: "GAPPLICANT",
          reason: erroringReason,
        }),
      ).rejects.toThrow("decline failed");
    });

    expect(queryClient.getQueryData(detailKey)).toEqual(previous);
  });

  it("posts disputes and invalidates bounty queries on success", async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRaiseDispute(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        bountyId,
        reason: "OTHER" as never,
        description: "Needs a maintainer review.",
      });
    });

    expect(mockPost).toHaveBeenCalledWith("/api/disputes", {
      campaignId: bountyId,
      reason: "OTHER",
      description: "Needs a maintainer review.",
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: bountyKeys.detail(bountyId),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: bountyKeys.lists(),
    });
  });
});
