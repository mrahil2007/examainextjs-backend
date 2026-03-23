const admin = require("firebase-admin");

async function sendToUser(userId, title, body, type) {
  const user = await User.findOne({ userId });
  if (!user?.fcmToken) return;

  await admin.messaging().send({
    token: user.fcmToken,
    notification: { title, body },
    data: { type },
    android: {
      priority: "high",
      notification: {
        channelId: type === "job" ? "job_alerts" : "current_affairs",
      },
    },
  });
}

// Call this in your JobFetcher.js after new jobs are inserted:
async function notifyNewJobs(count) {
  const users = await User.find({ fcmToken: { $exists: true } });
  for (const user of users) {
    await sendToUser(
      user.userId,
      "🏛️ New Jobs Available",
      `${count} new government & private jobs just posted!`,
      "job"
    );
  }
}

// Call this in your current affairs cron:
async function notifyCurrentAffairs(date) {
  const users = await User.find({ fcmToken: { $exists: true } });
  for (const user of users) {
    await sendToUser(
      user.userId,
      "📰 Today's Current Affairs",
      `Your daily digest for ${date} is ready!`,
      "current_affairs"
    );
  }
}

module.exports = { sendToUser, notifyNewJobs, notifyCurrentAffairs };
