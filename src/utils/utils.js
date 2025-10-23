import jwt from "jsonwebtoken";
import { Conversation } from "../models.js";

export function signJWT(payload, secret) {
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function verifyJWT(token, secret) {
  return jwt.verify(token, secret);
}

export async function getOrCreateDirectConversation(aId, bId) {
  // find existing with exactly these two members
  let conv = await Conversation.findOne({
    type: "DIRECT",
    members: {
      $all: [{ $elemMatch: { user: aId } }, { $elemMatch: { user: bId } }],
    },
  });
  if (conv) return conv;
  conv = await Conversation.create({
    type: "DIRECT",
    members: [{ user: aId }, { user: bId }],
  });
  return conv;
}

export function otherMemberId(conv, myId) {
  const other = conv.members.find((m) => String(m.user) !== String(myId));
  return other?.user;
}
