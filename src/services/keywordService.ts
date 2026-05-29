import { prisma } from "../lib/prisma.js";

export function normalizeKeyword(text: string): string {
  return text.trim().toUpperCase();
}

export function extractKeyword(commentText: string): string | null {
  const tokens = commentText.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return normalizeKeyword(tokens[0]!);
}

export async function findActiveKeyword(keyword: string) {
  return prisma.keyword.findFirst({
    where: { keyword: normalizeKeyword(keyword), active: true },
  });
}
