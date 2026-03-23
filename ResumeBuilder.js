// ═══════════════════════════════════════════════════════════════════════════
// resumeBuilder.js — AI-powered resume builder
//
// Routes
//   POST /resume/generate        — generate full resume JSON from user input
//   POST /resume/tailor          — tailor an existing resume to a job description
//   POST /resume/review          — get ATS score + improvement suggestions
//   POST /resume/cover-letter    — generate a matching cover letter
//   GET  /resume/:userId         — list saved resumes
//   POST /resume/:userId/save    — save a resume to DB
//   DELETE /resume/:userId/:id   — delete a saved resume
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from "express";
import { ObjectId } from "mongodb";

// ── Prompts ───────────────────────────────────────────────────────────────────

const buildResumeGeneratePrompt = (input) => `
You are an expert resume writer with 15+ years of experience writing ATS-optimised resumes for Indian job seekers.

USER INPUT:
${JSON.stringify(input, null, 2)}

Generate a complete, professional resume in JSON format. Use strong action verbs and quantified achievements.

Return ONLY valid JSON — no markdown, no extra text:
{
  "name": "Full Name",
  "contact": {
    "email": "",
    "phone": "",
    "location": "",
    "linkedin": "",
    "github": ""
  },
  "summary": "3–4 sentence professional summary tailored to the target role.",
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "location": "City, State",
      "startDate": "MMM YYYY",
      "endDate": "MMM YYYY or Present",
      "bullets": [
        "Strong action verb + task + quantified result",
        "..."
      ]
    }
  ],
  "education": [
    {
      "degree": "B.Tech Computer Science",
      "institution": "University Name",
      "location": "City",
      "year": "YYYY",
      "cgpa": "X.X / 10 (optional)"
    }
  ],
  "skills": {
    "technical": ["skill1", "skill2"],
    "soft": ["skill1", "skill2"],
    "tools": ["tool1", "tool2"],
    "languages": ["lang1", "lang2"]
  },
  "certifications": [
    { "name": "", "issuer": "", "year": "" }
  ],
  "projects": [
    {
      "name": "Project Name",
      "tech": ["React", "Node.js"],
      "description": "What it does + impact",
      "link": ""
    }
  ],
  "achievements": ["Achievement 1", "Achievement 2"],
  "atsScore": 85,
  "atsTips": ["Tip 1", "Tip 2", "Tip 3"]
}`;

const buildTailorPrompt = (resume, jobDescription) => `
You are an ATS optimisation expert. Tailor the resume below to maximise match with the job description.

ORIGINAL RESUME:
${JSON.stringify(resume, null, 2)}

TARGET JOB DESCRIPTION:
${jobDescription}

Rules:
1. Rewrite the summary to mirror keywords from the JD.
2. Reorder bullet points to lead with the most relevant achievements.
3. Add missing keywords naturally — never fabricate experience.
4. Update skills list to include all matching terms from JD.
5. Return the SAME JSON structure as the input resume, plus these extra fields:
   "matchScore": <0–100 number>,
   "matchedKeywords": ["kw1", "kw2"],
   "missingKeywords": ["kw1", "kw2"],
   "tailorTips": ["tip1", "tip2"]

Return ONLY valid JSON — no markdown, no extra text.`;

const buildReviewPrompt = (resume) => `
You are a senior recruiter and ATS specialist. Critically review this resume.

RESUME:
${JSON.stringify(resume, null, 2)}

Provide a detailed review. Return ONLY valid JSON:
{
  "overallScore": <0–100>,
  "sections": {
    "summary":      { "score": 0, "feedback": "" },
    "experience":   { "score": 0, "feedback": "" },
    "skills":       { "score": 0, "feedback": "" },
    "education":    { "score": 0, "feedback": "" },
    "formatting":   { "score": 0, "feedback": "" },
    "atsReadiness": { "score": 0, "feedback": "" }
  },
  "strengths": ["strength1", "strength2"],
  "improvements": [
    { "priority": "High", "issue": "", "fix": "" },
    { "priority": "Medium", "issue": "", "fix": "" }
  ],
  "keywordDensity": "Low | Medium | High",
  "readabilityScore": <0–100>,
  "suggestedRoles": ["Role 1", "Role 2", "Role 3"]
}`;

const buildCoverLetterPrompt = (resume, jobTitle, company, jobDescription) => `
You are a professional cover letter writer. Write a compelling, personalised cover letter.

CANDIDATE RESUME SUMMARY:
Name: ${resume.name}
Role applying for: ${jobTitle} at ${company}
Summary: ${resume.summary}
Top skills: ${[
  ...(resume.skills?.technical || []),
  ...(resume.skills?.soft || []),
]
  .slice(0, 8)
  .join(", ")}
Key experience: ${(resume.experience || [])
  .slice(0, 2)
  .map((e) => `${e.title} at ${e.company}`)
  .join("; ")}

JOB DESCRIPTION HIGHLIGHTS:
${jobDescription?.substring(0, 800) || "Not provided"}

RULES:
- 3 paragraphs: Hook + Why me + Call to action
- Mirror 4–5 keywords from JD naturally
- Confident, not desperate tone
- Max 280 words
- No generic openers like "I am writing to apply…"

Return ONLY valid JSON:
{
  "subject": "Application for ${jobTitle} — ${resume.name}",
  "body": "Full cover letter text here…",
  "wordCount": 0,
  "keywordsUsed": ["kw1", "kw2"]
}`;

// ── AI caller (uses the same pattern as server.js) ────────────────────────────
const callGroq = async (prompt) => {
  const models = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b-versatile",
  ];
  for (const model of models) {
    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_completion_tokens: 4096,
          }),
        }
      );
      if (!response.ok) continue;
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch {
      continue;
    }
  }
  throw new Error("All AI models failed");
};

const parseJSON = (raw) => {
  const clean = raw.replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  return JSON.parse(clean.slice(start, end + 1));
};

// ── Router factory ────────────────────────────────────────────────────────────
/**
 * @param {() => import('mongodb').Collection} getResumes — db collection accessor
 */
export default function createResumeRouter(getResumes) {
  const router = Router();

  // ── POST /resume/generate ─────────────────────────────────────────────────
  router.post("/generate", async (req, res) => {
    // Frontend sends { form: { fullName, targetRole, ... }, userId }
    // Support both nested { form } and flat body for flexibility
    const src = req.body.form || req.body;
    const { userId } = req.body;

    const {
      fullName,
      name: _name,
      targetRole,
      role,
      email,
      phone,
      location,
      linkedin,
      github,
      summary = "",
      experience = [],
      education = [],
      skills = "",
      certifications = "",
      languages = "",
      targetTemplate = "General / Fresher",
    } = src;

    const name = fullName || _name || "";
    const resolvedRole = targetRole || role || "";

    if (!name.trim() || !resolvedRole.trim()) {
      return res
        .status(400)
        .json({ error: "name and targetRole are required" });
    }

    // Normalise experience bullets: frontend stores as newline string, backend wants array
    const normExp = (experience || []).map((e) => ({
      title: e.role || e.title || "",
      company: e.company || "",
      location: "",
      startDate: "",
      endDate: e.duration || "",
      bullets:
        typeof e.points === "string"
          ? e.points
              .split("\n")
              .map((p) => p.replace(/^[-•*]\s*/, ""))
              .filter(Boolean)
          : e.bullets || [],
    }));

    const normEdu = (education || []).map((e) => ({
      degree: e.degree || "",
      institution: e.institution || "",
      location: "",
      year: e.year || "",
      cgpa: e.score || "",
    }));

    const normSkills =
      typeof skills === "string"
        ? {
            technical: skills
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : skills;

    try {
      const prompt = buildResumeGeneratePrompt({
        name,
        email,
        phone,
        location,
        linkedin,
        github,
        targetRole: resolvedRole,
        summary,
        experience: normExp,
        education: normEdu,
        skills: normSkills,
        projects: [],
        certifications:
          typeof certifications === "string"
            ? certifications
                .split("\n")
                .filter(Boolean)
                .map((c) => ({ name: c.replace(/^[-•*]\s*/, "") }))
            : [],
        achievements: [],
        languages,
        targetTemplate,
      });

      const raw = await callGroq(prompt);
      const resume = parseJSON(raw);

      // Normalise skills: AI returns object {technical,soft,tools} — flatten to comma string
      // so ResumePreview can always do skills.split(",")
      if (resume.skills && typeof resume.skills === "object") {
        const all = [
          ...(resume.skills.technical || []),
          ...(resume.skills.soft || []),
          ...(resume.skills.tools || []),
          ...(resume.skills.languages || []),
        ];
        resume.skills = all.join(", ");
      }

      // Normalise experience: AI may return {title,bullets} — map to {role,company,duration,points}
      if (Array.isArray(resume.experience)) {
        resume.experience = resume.experience.map((e) => ({
          role: e.title || e.role || "",
          company: e.company || "",
          duration: e.endDate || e.duration || "",
          points: Array.isArray(e.bullets)
            ? e.bullets.join("\n")
            : e.points || "",
        }));
      }

      // Normalise education: AI may return {degree,institution,year,cgpa}
      if (Array.isArray(resume.education)) {
        resume.education = resume.education.map((e) => ({
          degree: e.degree || "",
          institution: e.institution || "",
          year: e.year || "",
          score: e.cgpa || e.score || "",
        }));
      }

      // Normalise certifications: AI returns [{name,issuer,year}] — flatten to string
      if (Array.isArray(resume.certifications)) {
        resume.certifications = resume.certifications
          .map((c) =>
            typeof c === "string"
              ? c
              : `${c.name}${c.issuer ? " — " + c.issuer : ""}${
                  c.year ? " (" + c.year + ")" : ""
                }`
          )
          .join("\n");
      }

      // Auto-save to DB if userId provided
      let resumeId = null;
      if (req.body.userId) {
        const result = await getResumes().insertOne({
          userId: req.body.userId,
          resume,
          form: src,
          title: name,
          targetRole: resolvedRole,
          atsScore: resume.atsScore || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        resumeId = result.insertedId;
      }

      res.json({ resume, resumeId });
    } catch (err) {
      console.error("Resume generate error:", err.message);
      res.status(500).json({ error: "Failed to generate resume" });
    }
  });

  // ── POST /resume/tailor ───────────────────────────────────────────────────
  router.post("/tailor", async (req, res) => {
    const { resume, jobDescription } = req.body;
    if (!resume || !jobDescription) {
      return res
        .status(400)
        .json({ error: "resume and jobDescription required" });
    }
    try {
      const raw = await callGroq(buildTailorPrompt(resume, jobDescription));
      const tailored = parseJSON(raw);
      res.json({ resume: tailored });
    } catch (err) {
      console.error("Resume tailor error:", err.message);
      res.status(500).json({ error: "Failed to tailor resume" });
    }
  });

  // ── POST /resume/review ───────────────────────────────────────────────────
  router.post("/review", async (req, res) => {
    const { resume } = req.body;
    if (!resume) return res.status(400).json({ error: "resume required" });
    try {
      const raw = await callGroq(buildReviewPrompt(resume));
      const review = parseJSON(raw);
      res.json({ review });
    } catch (err) {
      console.error("Resume review error:", err.message);
      res.status(500).json({ error: "Failed to review resume" });
    }
  });

  // ── POST /resume/cover-letter ─────────────────────────────────────────────
  router.post("/cover-letter", async (req, res) => {
    const { resume, jobTitle, company, jobDescription } = req.body;
    if (!resume || !jobTitle || !company) {
      return res
        .status(400)
        .json({ error: "resume, jobTitle, and company required" });
    }
    try {
      const raw = await callGroq(
        buildCoverLetterPrompt(resume, jobTitle, company, jobDescription)
      );
      const result = parseJSON(raw);
      res.json({ coverLetter: result });
    } catch (err) {
      console.error("Cover letter error:", err.message);
      res.status(500).json({ error: "Failed to generate cover letter" });
    }
  });

  // ── GET /resume/:userId — list saved resumes ──────────────────────────────
  router.get("/:userId", async (req, res) => {
    try {
      const resumes = await getResumes()
        .find({ userId: req.params.userId })
        .sort({ updatedAt: -1 })
        .project({
          title: 1,
          targetRole: 1,
          atsScore: 1,
          updatedAt: 1,
          "form.targetTemplate": 1,
        })
        .toArray();
      res.json(resumes);
    } catch (err) {
      res.status(500).json({ error: "Failed to load resumes" });
    }
  });

  // ── GET /resume/:userId/:id — single resume (used by openSavedResume) ────
  router.get("/:userId/:id", async (req, res) => {
    try {
      const doc = await getResumes().findOne({
        _id: new ObjectId(req.params.id),
        userId: req.params.userId,
      });
      if (!doc) return res.status(404).json({ error: "Resume not found" });
      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: "Failed to load resume" });
    }
  });

  // ── POST /resume/:userId/save ─────────────────────────────────────────────
  router.post("/:userId/save", async (req, res) => {
    const { resume, targetRole } = req.body;
    if (!resume) return res.status(400).json({ error: "resume required" });
    try {
      const doc = {
        userId: req.params.userId,
        resume,
        targetRole: targetRole || resume.contact?.email || "Untitled",
        atsScore: resume.atsScore || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await getResumes().insertOne(doc);
      res.json({ success: true, resumeId: result.insertedId });
    } catch (err) {
      res.status(500).json({ error: "Failed to save resume" });
    }
  });

  // ── DELETE /resume/:userId/:id ────────────────────────────────────────────
  router.delete("/:userId/:id", async (req, res) => {
    try {
      await getResumes().deleteOne({
        _id: new ObjectId(req.params.id),
        userId: req.params.userId,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete resume" });
    }
  });

  return router;
}
