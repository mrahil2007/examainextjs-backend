// In your user router
router.post("/user/fcm-token", async (req, res) => {
  const { userId, token } = req.body;
  await User.findOneAndUpdate(
    { userId },
    { fcmToken: token },
    { upsert: true }
  );
  res.json({ success: true });
});
