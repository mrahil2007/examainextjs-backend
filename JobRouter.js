// ═══════════════════════════════════════════════════════════════════════════
// jobRouter.js — Express router: GET /jobs · GET /jobs/:id · POST /jobs/subscribe
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from "express";
import { ObjectId } from "mongodb";

export default function createJobRouter(getJobs) {
  const router = Router();

  // ── GET /jobs — paginated list with optional filters ──────────────────────
  router.get("/", async (req, res) => {
    try {
      const { exam, category, page = 1, limit = 20, isNew, search } = req.query;

      const filter = { _isMeta: { $ne: true } };
      if (exam) filter.exam = { $in: [exam] };

      // category filter: govt | pvt | international
      if (category === "government") filter.category = "government";
      if (category === "private") filter.category = "private";
      if (category === "international") filter.category = "international";
      if (category === "remote") filter.category = "remote";

      if (isNew !== undefined) filter.isNew = isNew === "true";

      // Search: match title or organization (case-insensitive)
      if (search && search.trim()) {
        filter.$or = [
          { title: { $regex: search.trim(), $options: "i" } },
          { organization: { $regex: search.trim(), $options: "i" } },
        ];
      }

      const pageNum = Math.max(1, Number(page));
      const limitNum = Math.min(100, Math.max(1, Number(limit)));

      const [jobs, total] = await Promise.all([
        getJobs()
          .find(filter)
          .sort({ postedAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .toArray(),
        getJobs().countDocuments(filter),
      ]);

      res.json({
        jobs,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      console.error("GET /jobs error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /jobs/subscribe ──────────────────────────────────────────────────

  // ── GET /jobs/:id ─────────────────────────────────────────────────────────
  router.get("/:id", async (req, res) => {
    try {
      const job = await getJobs().findOne({ _id: new ObjectId(req.params.id) });
      if (!job) return res.status(404).json({ error: "Job not found" });
      res.json(job);
    } catch (err) {
      console.error("GET /jobs/:id error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /jobs/:id/ask-ai ──────────────────────────────────────────────────
  router.get("/:id/ask-ai", async (req, res) => {
    try {
      const job = await getJobs().findOne({ _id: new ObjectId(req.params.id) });
      if (!job) return res.status(404).json({ error: "Job not found" });

      const isIntl = job.category === "international";

      const prompt = `I want complete information about this ${
        isIntl ? "international" : "government"
      } job:

📌 **${job.title}**
🏢 Organization: ${job.organization}
📍 Location: ${job.location || "N/A"}
${
  isIntl
    ? `🌍 Country: ${job.country || "N/A"}\n💰 Salary: ${job.salary}`
    : `📅 Last Date: ${job.lastDate}\n💼 Vacancies: ${job.vacancies}\n💰 Salary: ${job.salary}`
}

Please give me:
1. ✅ **Eligibility Criteria** — qualifications, experience, skills required
2. 📚 **Role & Responsibilities** — what the job involves day-to-day
3. 💰 **Salary & Benefits** — pay, perks, growth opportunities
4. 📅 **How to Apply** — step-by-step application process
5. 📖 **Preparation Tips** — skills to build, certifications to get
6. 🎯 **Selection Process** — interview rounds, assessments`;

      res.json({ prompt, job });
    } catch (err) {
      console.error("GET /jobs/:id/ask-ai error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
