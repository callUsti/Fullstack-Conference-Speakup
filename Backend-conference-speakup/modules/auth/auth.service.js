// ============================================================================
// SpeakUp — Auth Service
// Firebase-backed authentication + PostgreSQL user sync
// ============================================================================

import admin from "../../config/firebase-admin.config.js";
import { prisma } from "../../config/prisma.js";
import { setCache, deleteCache } from "../../services/redis.service.js";
import { CacheTTL } from "../../config/constants.js";
import { createLogger } from "../../logs/logger.js";
import { queueEmail } from "../../services/workers.js";

const log = createLogger("AuthService");

export async function signInUser(decodedToken) {
  const provider = decodedToken.firebase?.sign_in_provider === "github.com" ? "GITHUB" : "GOOGLE";

  let user = await prisma.user.findUnique({
    where: { firebaseUid: decodedToken.uid },
    include: { accounts: true, subscriptions: true },
  });

  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    user = await prisma.user.create({
      data: {
        firebaseUid: decodedToken.uid,
        email: decodedToken.email,
        fullName: decodedToken.name || decodedToken.email?.split("@")[0] || "User",
        avatar: decodedToken.picture || null,
        isOnline: true,
        lastSeenAt: new Date(),
        accounts: {
          create: { provider, providerId: decodedToken.uid },
        },
        subscriptions: {
          create: { plan: "FREE", status: "ACTIVE" },
        },
      },
      include: { accounts: true, subscriptions: true },
    });

    await queueEmail("welcome", user.email, { id: user.id, name: user.fullName }).catch((e) =>
      log.warn("Failed to queue welcome email", { error: e })
    );

    log.info("New user created", { userId: user.id, provider });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { isOnline: true, lastSeenAt: new Date() },
    });
  }

  await setCache(`user:${user.id}`, sanitizeUser(user), CacheTTL.USER_PROFILE);

  return { user: sanitizeUser(user), isNewUser };
}

export async function signOutUser(userId) {
  await prisma.user.update({
    where: { id: userId },
    data: { isOnline: false, lastSeenAt: new Date() },
  });
  await deleteCache(`user:${userId}`);
}



export async function getUserProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { accounts: true, subscriptions: true },
  });
  return user ? sanitizeUser(user) : null;
}



export async function deleteUserAccount(userId, firebaseUid) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  // Delete all meetings where user is host
  await prisma.meeting.deleteMany({ where: { hostId: userId } });

  // Optionally: delete other related data (participants, invites, etc.)

  // Delete user from Prisma first
  await prisma.user.delete({ where: { id: userId } });
  await deleteCache(`user:${userId}`);

  // Now delete from Firebase
  try {
    await admin.auth().deleteUser(firebaseUid);
  } catch (e) {
    log.warn("Failed to delete Firebase user", { firebaseUid, error: e });
  }

  await queueEmail("goodbye", user.email, { id: user.id, name: user.fullName }).catch(() => {});

  log.info("User account deleted", { userId });
  return true;
}

function sanitizeUser(user) {
  const { firebaseUid, ...rest } = user;
  return {
    ...rest,
    accounts: rest.accounts?.map(({ id, provider, createdAt }) => ({ id, provider, createdAt })),
    subscription: rest.subscriptions || null,
    subscriptions: undefined,
  };
}
