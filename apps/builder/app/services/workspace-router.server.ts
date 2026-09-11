import { z } from "zod";
import {
  router,
  procedure,
  createErrorResponse,
  getPlanFeaturesByOwnerId,
} from "@webstudio-is/trpc-interface/index.server";
import { workspace as workspaceApi } from "@webstudio-is/project/index.server";
import { roles } from "@webstudio-is/trpc-interface/authorize";
import { getExtraPaidSeats } from "@webstudio-is/plans/index.server";
import env from "~/env/env.server";

const name = z.string().min(2).max(100);
const relation = z.enum(roles);

/**
 * Tells the payment worker to count members and adjust Stripe seats.
 * All member-counting and Stripe logic lives in the worker — the builder
 * only passes the workspaceId and an optional delta.
 *
 * @param delta - adjustment to the current member count.
 *   Pass +1 when a member is about to be added (pre-charge before DB insert).
 *   Defaults to 0 (post-removal or manual sync).
 */
const syncSeats = async (workspaceId: string, delta = 0): Promise<void> => {
  if (!env.PAYMENT_WORKER_URL || !env.PAYMENT_WORKER_TOKEN) {
    return;
  }

  const response = await fetch(`${env.PAYMENT_WORKER_URL}/seats/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.PAYMENT_WORKER_TOKEN}`,
    },
    body: JSON.stringify({ workspaceId, delta }),
  });

  if (!response.ok) {
    throw new Error(
      `Payment worker /seats/sync responded with ${response.status}`
    );
  }

  const result = (await response.json()) as {
    type: string;
    error?: string;
  };

  if (result.type === "error") {
    throw new Error(`Payment worker rejected seat sync: ${result.error}`);
  }
};

export const workspaceRouter = router({
  create: procedure
    .input(z.object({ name: name }))
    .mutation(async ({ input, ctx }) => {
      try {
        const workspace = await workspaceApi.create(
          { ...input, maxWorkspaces: ctx.planFeatures.maxWorkspaces },
          ctx
        );
        return { success: true as const, data: workspace };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  rename: procedure
    .input(z.object({ workspaceId: z.string(), name: name }))
    .mutation(async ({ input, ctx }) => {
      try {
        const workspace = await workspaceApi.rename(input, ctx);
        return { success: true as const, data: workspace };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  delete: procedure
    .input(
      z.object({
        workspaceId: z.string(),
        deleteProjects: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.remove(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  list: procedure.query(async ({ ctx }) => {
    try {
      if (ctx.authorization.type !== "user") {
        return { success: true as const, data: [] };
      }
      const workspaces = await workspaceApi.findMany(
        ctx.authorization.userId,
        ctx
      );
      return { success: true as const, data: workspaces };
    } catch (error) {
      return createErrorResponse(error);
    }
  }),

  addMember: procedure
    .input(
      z.object({
        workspaceId: z.string(),
        email: z.string().email(),
        relation: relation,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { plan } = await workspaceApi.assertWorkspaceOwnerPlan(
          input.workspaceId,
          ctx
        );

        if (plan.maxWorkspaces <= 1) {
          throw new Error("Upgrade your plan to invite members to workspaces.");
        }

        // Self-hosted: there is no payment provider. Access is already gated by
        // the Nextcloud login/group check, so any authenticated user is
        // entitled to the full builder and may be invited to a workspace. The
        // upstream "requires a configured payment provider" gate and the
        // per-invite Stripe seat pre-charge are intentionally omitted here.
        // The finite seat ceiling below is kept only to bound resource use on
        // a single VPS.
        const { maxSeatsPerWorkspace } = plan;
        if (maxSeatsPerWorkspace > 0) {
          const [membersResult, pendingResult] = await Promise.all([
            ctx.postgrest.client
              .from("WorkspaceMember")
              .select("userId", { count: "exact", head: true })
              .eq("workspaceId", input.workspaceId)
              .is("removedAt", null),
            ctx.postgrest.client
              .from("Notification")
              .select("id", { count: "exact", head: true })
              .eq("type", "workspaceInvite")
              .eq("status", "pending")
              .filter("payload->>workspaceId", "eq", input.workspaceId),
          ]);

          if (membersResult.error) {
            throw membersResult.error;
          }
          if (pendingResult.error) {
            throw pendingResult.error;
          }

          const currentCount =
            (membersResult.count ?? 0) + (pendingResult.count ?? 0);
          if (currentCount >= maxSeatsPerWorkspace) {
            throw new Error(
              `This workspace has reached its seat limit of ${maxSeatsPerWorkspace}. Remove a member to invite more.`
            );
          }
        }

        // workspaceApi.addMember validates that the invitee exists and is not
        // already a member, then creates a pending workspaceInvite
        // notification the recipient accepts.
        const { notificationId } = await workspaceApi.addMember(input, ctx);

        return { success: true as const, notificationId };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  updateRole: procedure
    .input(
      z.object({
        workspaceId: z.string(),
        memberUserId: z.string(),
        relation: relation,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { plan } = await workspaceApi.assertWorkspaceOwnerPlan(
          input.workspaceId,
          ctx
        );

        if (plan.maxWorkspaces <= 1) {
          throw new Error(
            "Upgrade your plan to manage workspace member roles."
          );
        }
        await workspaceApi.updateRole(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  removeMember: procedure
    .input(z.object({ workspaceId: z.string(), memberUserId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.removeMember(input, ctx);
        await syncSeats(input.workspaceId);

        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  syncSeats: procedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const { plan } = await workspaceApi.assertWorkspaceOwnerPlan(
          input.workspaceId,
          ctx
        );

        if (plan.maxWorkspaces <= 1) {
          throw new Error("Upgrade your plan to manage workspace seats.");
        }
        await syncSeats(input.workspaceId);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  listMembers: procedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const members = await workspaceApi.listMembers(input, ctx);
        const [ownerPlan, extraPaidSeats] = await Promise.all([
          getPlanFeaturesByOwnerId(members.owner.userId, ctx),
          getExtraPaidSeats(members.owner.userId, ctx),
        ]);
        return {
          success: true as const,
          data: {
            ...members,
            // seatsIncluded = seats covered by the Team plan.
            // extraPaidSeats = extra seats from the Seats subscription.
            // Total capacity = included + extras.
            maxSeats: ownerPlan.seatsIncluded + (extraPaidSeats ?? 0),
          },
        };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  /**
   * All registered users, for the "invite member" picker on this self-hosted
   * deploy. Only a workspace owner may enumerate accounts, and only the fields
   * needed to render and select a member are returned (no provider/internal
   * data). Upstream SaaS invites by typing an email; here the operator picks
   * from the known Nextcloud-provisioned accounts instead.
   */
  listRegisteredUsers: procedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        await workspaceApi.assertWorkspaceOwnerPlan(input.workspaceId, ctx);

        const result = await ctx.postgrest.client
          .from("User")
          .select("id, email, username")
          .not("email", "is", null)
          .order("email", { ascending: true });

        if (result.error) {
          throw result.error;
        }

        const users = (result.data ?? []).flatMap((user) =>
          user.email === null || user.email === undefined
            ? []
            : [
                {
                  userId: user.id,
                  email: user.email,
                  username: user.username ?? null,
                },
              ]
        );

        return { success: true as const, data: users };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  moveProject: procedure
    .input(
      z.object({
        projectId: z.string(),
        targetWorkspaceId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const targetWorkspace = await ctx.postgrest.client
          .from("Workspace")
          .select("userId")
          .eq("id", input.targetWorkspaceId)
          .eq("isDeleted", false)
          .maybeSingle();

        if (targetWorkspace.error) {
          throw targetWorkspace.error;
        }

        if (targetWorkspace.data === null) {
          throw new Error("Target workspace not found");
        }

        const ownerPlan = await getPlanFeaturesByOwnerId(
          targetWorkspace.data.userId,
          ctx
        );

        if (ownerPlan.maxWorkspaces <= 1) {
          throw new Error(
            "Upgrade your plan to move projects between workspaces."
          );
        }
        await workspaceApi.moveProject(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  transferProject: procedure
    .input(
      z.object({
        projectId: z.string(),
        recipientEmail: z.string().email(),
        targetWorkspaceId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.transferProject(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  findSharedWorkspacesByOwnerEmail: procedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input, ctx }) => {
      try {
        const workspaces = await workspaceApi.findSharedWorkspacesByOwnerEmail(
          input,
          ctx
        );
        return { success: true as const, data: workspaces };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),
});

export type WorkspaceRouter = typeof workspaceRouter;
