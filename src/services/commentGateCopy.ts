export type CommentGate = {
  variant: "known_follower" | "default";
  text: string;
};

export function selectCommentGate(input: {
  isFollower: boolean | null;
  defaultMessage: string;
}): CommentGate {
  if (input.isFollower) {
    return {
      variant: "known_follower",
      text: "So lovely to see you again 💛 Reply DONE and I’ll send your guide right over.",
    };
  }

  return { variant: "default", text: input.defaultMessage };
}
