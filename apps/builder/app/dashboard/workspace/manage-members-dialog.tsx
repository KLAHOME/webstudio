import { useCallback, useEffect, useMemo, useState } from "react";
import { useRevalidator } from "@remix-run/react";
import {
  Button,
  Box,
  Flex,
  Label,
  List,
  ListItem,
  Text,
  DialogActions,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogClose,
  IconButton,
  InputErrorsTooltip,
  ScrollAreaNative,
  Select,
  Tooltip,
  css,
  theme,
  cssVar,
} from "@webstudio-is/design-system";
import { TrashIcon } from "@webstudio-is/icons";
import { type Workspace, type Role } from "@webstudio-is/project";
import { nativeClient, trpcClient } from "~/shared/trpc/trpc-client";
import { RoleSelect } from "./role-select";

const memberItemStyle = css({
  paddingInline: theme.spacing[5],
  paddingBlock: theme.spacing[3],
  borderRadius: theme.borderRadius[4],
  outline: "none",
  "&:hover, &:focus-within": {
    backgroundColor: cssVar("--overlay-interaction-hover"),
  },
  "& [data-action]": {
    visibility: "hidden",
  },
  "&:hover [data-action], &:focus-within [data-action]": {
    visibility: "visible",
  },
});

type MemberRowProps = {
  email: string;
  index: number;
} & (
  | { role: "owner" }
  | {
      role: "member";
      userId: string;
      workspaceId: string;
      relation: Role;
      canRemove: boolean;
      onRefresh: () => void;
    }
  | {
      role: "pending";
      relation: Role;
      canRemove: boolean;
      onRemove: () => void;
    }
);

const MemberRow = (props: MemberRowProps) => {
  const { email, index, role } = props;
  const removeMutation = trpcClient.workspace.removeMember.useMutation();
  const updateMutation = trpcClient.workspace.updateRole.useMutation();
  const revalidator = useRevalidator();
  const [error, setError] = useState<string>();
  const [localRole, setLocalRole] = useState<Role>(
    role !== "owner" ? props.relation : "administrators"
  );

  const selectElement = (() => {
    if (role === "owner") {
      return (
        <Select color="ghost" options={["Owner"]} value="Owner" disabled />
      );
    }

    if (role === "pending") {
      return (
        <Text color="subtle" variant="regular">
          Pending…
        </Text>
      );
    }

    return (
      <RoleSelect
        color="ghost"
        value={localRole}
        onChange={(newRole: Role) => {
          setError(undefined);
          setLocalRole(newRole);
          updateMutation.send(
            {
              workspaceId: props.workspaceId,
              memberUserId: props.userId,
              relation: newRole,
            },
            (result) => {
              if (result && "error" in result) {
                setError(result.error);
                setLocalRole(props.relation);
                return;
              }
              props.onRefresh();
              revalidator.revalidate();
            }
          );
        }}
        disabled={!props.canRemove}
      />
    );
  })();

  const deleteElement = (() => {
    if (role === "owner") {
      return (
        <IconButton aria-label="Remove member" tabIndex={-1} disabled>
          <TrashIcon />
        </IconButton>
      );
    }

    if (props.canRemove) {
      return (
        <Tooltip
          content={error ?? "Remove member"}
          variant={error ? "wrapped" : undefined}
          open={error ? true : undefined}
        >
          <IconButton
            data-action
            tabIndex={-1}
            aria-label="Remove member"
            onClick={() => {
              if (role === "pending") {
                props.onRemove();
                return;
              }
              setError(undefined);
              removeMutation.send(
                {
                  workspaceId: props.workspaceId,
                  memberUserId: props.userId,
                },
                (result) => {
                  if (result && "error" in result) {
                    setError(result.error);
                    return;
                  }
                  props.onRefresh();
                  revalidator.revalidate();
                }
              );
            }}
            disabled={
              role === "member" ? removeMutation.state !== "idle" : false
            }
          >
            <TrashIcon />
          </IconButton>
        </Tooltip>
      );
    }

    return (
      <IconButton
        aria-label="Remove member"
        tabIndex={-1}
        disabled
        css={{ visibility: "hidden" }}
      >
        <TrashIcon />
      </IconButton>
    );
  })();

  return (
    <ListItem index={index} asChild>
      <Flex
        align="center"
        gap="2"
        justify="between"
        className={memberItemStyle()}
      >
        <Flex direction="column" css={{ minWidth: 0, flexGrow: 1 }}>
          <Text truncate>{email}</Text>
        </Flex>
        <Flex align="center" gap="1" css={{ flexShrink: 0 }}>
          {selectElement}
          {deleteElement}
        </Flex>
      </Flex>
    </ListItem>
  );
};

const MemberList = ({
  workspaceId,
  canRemove,
  membersData,
  onRefresh,
}: {
  workspaceId: string;
  canRemove: boolean;
  membersData:
    | Extract<
        Exclude<
          ReturnType<typeof trpcClient.workspace.listMembers.useQuery>["data"],
          undefined
        >,
        { success: true }
      >["data"]
    | undefined;
  onRefresh: () => void;
}) => {
  if (membersData === undefined) {
    return (
      <Text color="subtle" align="center">
        Loading members…
      </Text>
    );
  }

  const { owner, members, pendingInvites } = membersData;

  let index = 0;

  return (
    <List asChild>
      <Box>
        <MemberRow email={owner.email} role="owner" index={index++} />
        {members.map((member) => (
          <MemberRow
            key={member.userId}
            email={member.email ?? ""}
            role="member"
            userId={member.userId}
            workspaceId={workspaceId}
            relation={member.relation as Role}
            canRemove={canRemove}
            index={index++}
            onRefresh={onRefresh}
          />
        ))}
        {pendingInvites.map((invite) => (
          <MemberRow
            key={invite.notificationId}
            email={invite.email}
            role="pending"
            relation={invite.relation as Role}
            canRemove={canRemove}
            index={index++}
            onRemove={() => {
              nativeClient.notification.cancel
                .mutate({ notificationId: invite.notificationId })
                .then(() => onRefresh())
                .catch(() => {});
            }}
          />
        ))}
      </Box>
    </List>
  );
};

type RegisteredUser = { userId: string; email: string; username: string | null };

export const ManageMembersDialog = ({
  workspace,
  userId,
  isOpen,
  onOpenChange,
}: {
  workspace: Workspace;
  userId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const isOwner = workspace.userId === userId;
  const revalidator = useRevalidator();
  const [errors, setErrors] = useState<string[]>();
  const [inviting, setInviting] = useState(false);
  const [inviteRelation, setInviteRelation] = useState<Role>("viewers");
  const [selectedUserId, setSelectedUserId] = useState<string>();

  const { load, data } = trpcClient.workspace.listMembers.useQuery();
  const membersData = data?.success ? data.data : undefined;

  const { load: loadUsers, data: usersData } =
    trpcClient.workspace.listRegisteredUsers.useQuery();
  const registeredUsers: RegisteredUser[] = usersData?.success
    ? usersData.data
    : [];

  const handleRefresh = useCallback(() => {
    load({ workspaceId: workspace.id });
  }, [load, workspace.id]);

  useEffect(() => {
    if (isOpen && isOwner) {
      load({ workspaceId: workspace.id });
      loadUsers({ workspaceId: workspace.id });
    }
  }, [isOpen, isOwner, load, loadUsers, workspace.id]);

  // Users who can still be invited: everyone registered except the owner,
  // current members and already-pending invitees.
  const invitableUsers = useMemo(() => {
    const taken = new Set<string>();
    if (membersData !== undefined) {
      taken.add(membersData.owner.email);
      for (const m of membersData.members) {
        if (m.email) {
          taken.add(m.email);
        }
      }
      for (const p of membersData.pendingInvites) {
        taken.add(p.email);
      }
    }
    return registeredUsers.filter((u) => taken.has(u.email) === false);
  }, [registeredUsers, membersData]);

  const selectedUser = invitableUsers.find((u) => u.userId === selectedUserId);

  const performInvite = async () => {
    if (selectedUser === undefined) {
      return;
    }
    setErrors(undefined);
    setInviting(true);
    try {
      const result = await nativeClient.workspace.addMember.mutate({
        workspaceId: workspace.id,
        email: selectedUser.email,
        relation: inviteRelation,
      });
      if (result.success === false) {
        setErrors([result.error]);
      } else {
        setSelectedUserId(undefined);
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Unknown error";
      let message = raw;
      try {
        const issues = JSON.parse(raw);
        if (Array.isArray(issues) && issues.length > 0) {
          message = issues
            .map((i: { message?: string }) => i.message ?? "Invalid value")
            .join(", ");
        }
      } catch {
        // not JSON — use raw message as-is
      }
      setErrors([message]);
    } finally {
      setInviting(false);
      handleRefresh();
      revalidator.revalidate();
    }
  };

  const userLabel = (user: RegisteredUser) =>
    user.username ? `${user.username} (${user.email})` : user.email;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        onOpenChange(open);
        if (open === false) {
          setErrors(undefined);
          setSelectedUserId(undefined);
        }
      }}
    >
      <DialogContent css={{ width: theme.spacing[34] }}>
        <Flex direction="column" gap="3">
          {isOwner && (
            <Flex
              gap="1"
              direction="column"
              css={{
                px: theme.spacing[7],
                paddingTop: theme.spacing[5],
              }}
            >
              <Label>Invite members</Label>
              <Flex gap="2">
                <Box css={{ flexGrow: 1, minWidth: 0 }}>
                  <InputErrorsTooltip errors={errors}>
                    <Select<string>
                      placeholder={
                        invitableUsers.length === 0
                          ? "No users available"
                          : "Select a member…"
                      }
                      options={invitableUsers.map((u) => u.userId)}
                      value={selectedUserId}
                      getValue={(id) => id}
                      getLabel={(id) => {
                        const u = invitableUsers.find((x) => x.userId === id);
                        return u ? userLabel(u) : id;
                      }}
                      onChange={(id) => {
                        setErrors(undefined);
                        setSelectedUserId(id);
                      }}
                      disabled={invitableUsers.length === 0}
                    />
                  </InputErrorsTooltip>
                </Box>
                <RoleSelect
                  value={inviteRelation}
                  onChange={setInviteRelation}
                />
                <Button
                  color="primary"
                  type="button"
                  state={inviting ? "pending" : undefined}
                  disabled={selectedUser === undefined || inviting}
                  onClick={performInvite}
                >
                  Invite
                </Button>
              </Flex>
            </Flex>
          )}
          <ScrollAreaNative
            css={{
              maxHeight: 300,
              paddingTop: isOwner ? undefined : theme.spacing[5],
            }}
          >
            <Flex direction="column" gap="2" css={{ px: theme.spacing[7] }}>
              <Text variant="labels">Members</Text>
              <MemberList
                workspaceId={workspace.id}
                canRemove={isOwner}
                membersData={membersData}
                onRefresh={handleRefresh}
              />
            </Flex>
          </ScrollAreaNative>
        </Flex>
        <DialogActions>
          <Flex justify="end" align="center" grow>
            <DialogClose>
              <Button color="ghost">Cancel</Button>
            </DialogClose>
          </Flex>
        </DialogActions>
        <DialogTitle>Members</DialogTitle>
      </DialogContent>
    </Dialog>
  );
};
