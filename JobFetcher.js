// ═══════════════════════════════════════════════════════════════════════════
// jobFetcher.js — Job ingestion: RSS · FCM push · Cron scheduler
// ═══════════════════════════════════════════════════════════════════════════

import Parser from "rss-parser";
import cron from "node-cron";
import fetch from 'node-fetch';
import admin from "firebase-admin";

// ── Firebase Admin (FCM) ──────────────────────────────────────────────────────
let fcmEnabled = false;

export function initFirebase() {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (!admin.apps.length)
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      fcmEnabled = true;
      console.log("✅ Firebase Admin initialized — FCM enabled");
    } else {
      console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT not set — FCM push disabled.");
    }
  } catch (err) {
    console.warn("⚠️ Firebase Admin init failed:", err.message);
  }
}

// ── RSS parser config ─────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "ExamAI-JobBot/1.0" },
  customFields: { item: ["description", "pubDate", "link", "title"] },
  requestOptions: { rejectUnauthorized: false },
});

// ── RSS feed sources ──────────────────────────────────────────────────────────
const RSS_SOURCES = [
  {
    url: "https://www.freejobalert.com/feed/",
    organization: "Various Govt Organizations",
    exam: ["SSC", "UPSC", "Banking", "Railway", "State PSC", "General"],
    category: "government",
    source: "FreeJobAlert",
  },
  {
    url: "https://www.freejobalert.com/feed/?cat=latest-jobs",
    organization: "Various Govt Organizations",
    exam: ["SSC", "UPSC", "Banking", "Railway", "State PSC", "General"],
    category: "government",
    source: "FreeJobAlert Latest",
  },
  // ── Remote job feeds — category fixed to "remote" ────────────────────────
  {
    url: "https://remoteok.com/remote-jobs.rss",
    organization: "Various Companies",
    exam: ["General"],
    category: "remote", // ✅ fixed from "international"
    source: "RemoteOK",
  },
  {
    url: "https://weworkremotely.com/remote-jobs.rss",
    organization: "Various Companies",
    exam: ["General"],
    category: "remote", // ✅ fixed from "international"
    source: "We Work Remotely",
  },
  {
    url: "https://jobicy.com/?feed=job_feed",
    organization: "Various Companies",
    exam: ["General"],
    category: "remote", // ✅ fixed from "international"
    source: "Jobicy",
  },
];

// ── Text extraction helpers ───────────────────────────────────────────────────
export const extractLastDate = (text = "") => {
  const patterns = [
    /last date[:\s]+([\d]{1,2}[\s\-\/]\w+[\s\-\/][\d]{2,4})/i,
    /apply by[:\s]+([\d]{1,2}[\s\-\/]\w+[\s\-\/][\d]{2,4})/i,
    /closing date[:\s]+([\d]{1,2}[\s\-\/]\w+[\s\-\/][\d]{2,4})/i,
    /([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "See official site";
};

export const extractVacancies = (text = "") => {
  const match = text.match(
    /(\d[\d,]+)\s*(post|vacancy|vacancies|seat|opening)/i
  );
  return match ? match[1].replace(/,/g, "") + " posts" : "N/A";
};

export const mapToExams = (title = "", defaultExams = []) => {
  const lower = title.toLowerCase();
  const mapped = [];
  if (lower.includes("ssc")) mapped.push("SSC");
  if (lower.includes("upsc") || lower.includes("civil service"))
    mapped.push("UPSC");
  if (lower.includes("rrb") || lower.includes("railway"))
    mapped.push("Railway");
  if (lower.includes("ibps") || lower.includes("bank")) mapped.push("Banking");
  if (
    lower.includes("defence") ||
    lower.includes("army") ||
    lower.includes("navy")
  )
    mapped.push("Defence");
  if (lower.includes("psc")) mapped.push("State PSC");
  if (!mapped.includes("General")) mapped.push("General");
  return mapped.length > 0 ? mapped : [...defaultExams, "General"];
};

// ── Normalize category — ensures consistent values in DB ─────────────────────
const normalizeCategory = (raw = "", source = "", title = "", desc = "") => {
  const c = raw.toLowerCase().trim();
  const combined = `${title} ${desc}`.toLowerCase();

  // Remote sources always = remote
  if (["RemoteOK", "We Work Remotely", "Jobicy"].includes(source))
    return "remote";

  // Explicit remote signals
  if (
    c === "remote" ||
    combined.includes("work from home") ||
    combined.includes("remote work") ||
    combined.includes("wfh") ||
    (combined.includes("remote") && !combined.includes("remotely located"))
  )
    return "remote";

  // Government signals
  if (
    c === "government" ||
    c === "govt" ||
    combined.includes("government") ||
    combined.includes("sarkari") ||
    combined.includes("public sector")
  )
    return "government";

  // International signals
  if (
    c === "international" ||
    combined.includes("abroad") ||
    combined.includes("overseas") ||
    combined.includes("outside india")
  )
    return "international";

  // Private — default for Adzuna
  return "private";
};

// ── Titles to skip at ingestion ───────────────────────────────────────────────
const SKIP_TITLES = [
  "hello world",
  "dummy",
  "test post",
  "sample page",
  "ab dummy",
  "lorem ipsum",
  "untitled",
  "result",
  "results",
  "answer key",
  "admit card",
  "call letter",
  "cut off",
  "cutoff",
  "merit list",
  "scorecard",
  "score card",
  "final answer",
  "provisional answer",
  "response sheet",
  "document verification",
  "dv schedule",
  "exam date",
  "exam schedule",
  "hall ticket",
  "interview schedule",
  "interview letter",
  "joining letter",
  "appointment letter",
  "selection list",
  "waiting list",
  "rank list",
  "marks released",
  "certificate verification",
];

// ── Exam keyword map ──────────────────────────────────────────────────────────
const EXAM_KEYWORDS = {
  UPSC: ["upsc", "ias", "ips", "ifs", "civil service", "collector"],
  "SSC": ["ssc", "cgl", "income tax", "central excise", "ministry"],
  "SSC CHSL": ["ssc", "chsl", "ldc", "deo", "postal", "lower division"],
  Banking: ["bank", "ibps", "sbi", "rbi", "nabard", "clerk", "po"],
  Railway: ["railway", "rrb", "ntpc", "group d", "loco pilot"],
  Defence: [
    "army",
    "navy",
    "airforce",
    "cds",
    "nda",
    "defence",
    "military",
    "capf",
    "bsf",
    "crpf",
    "cisf",
  ],
  "State PSC": [
    "state psc",
    "state service",
    "hcs",
    "pcs",
    "bpsc",
    "mppsc",
    "uppsc",
  ],
  Teaching: [
    "teacher",
    "tgt",
    "pgt",
    "kvs",
    "nvs",
    "dsssb",
    "school",
    "lecturer",
    "professor",
  ],
  Police: ["police", "constable", "sub inspector", "asi", "dsp", "ssb"],
  General: [],
};

const isJobRelevantForExam = (job, exam) => {
  if (!exam || exam === "General") return true;
  const keywords = EXAM_KEYWORDS[exam] || [];
  if (keywords.length === 0) return true;
  const haystack = `${job.title} ${job.description || ""} ${(
    job.exam || []
  ).join(" ")}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
};

// ── Send FCM to individual user token ─────────────────────────────────────────
const sendPushToToken = async (token, title, body, jobCount) => {
  if (!fcmEnabled || !token) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: { type: "job_alert", count: String(jobCount) },
      android: {
        priority: "high",
        notification: { channelId: "job_alerts", color: "#10b981" },
      },
      apns: {
        payload: { aps: { badge: jobCount, sound: "default" } },
      },
    });
  } catch (e) {
    if (e.code !== "messaging/registration-token-not-registered") {
      console.warn("FCM send failed:", e.message);
    }
  }
};

// ── Send personalized notifications to all users ──────────────────────────────
const sendJobNotifications = async (getJobs, getUsers, since) => {
  if (!getUsers) return;

  const users = await getUsers()
    .find({ fcmToken: { $exists: true, $ne: null, $ne: "" } })
    .toArray();

  if (users.length === 0) {
    console.log("[JOBS] No users with FCM tokens");
    return;
  }

  const freshJobs = await getJobs()
    .find({ postedAt: { $gte: since } })
    .toArray();

  if (freshJobs.length === 0) {
    console.log("[JOBS] No fresh jobs to notify about");
    return;
  }

  console.log(
    `[JOBS] Notifying ${users.length} users about ${freshJobs.length} fresh jobs...`
  );
  let sent = 0,
    skipped = 0;

  for (const user of users) {
    if (!user.fcmToken) continue;

    const exam = user.exam || "General";
    const relevant = freshJobs.filter((j) => isJobRelevantForExam(j, exam));

    if (relevant.length === 0) {
      skipped++;
      continue;
    }

    const isGeneral = !exam || exam === "General";
    const notifTitle = isGeneral
      ? `🔔 ${relevant.length} New Job Alert${relevant.length > 1 ? "s" : ""}!`
      : `🔔 ${relevant.length} New ${exam} Job${
          relevant.length > 1 ? "s" : ""
        }!`;

    const top2 = relevant
      .slice(0, 2)
      .map((j) => j.title.substring(0, 40))
      .join(" • ");
    const notifBody =
      relevant.length > 2 ? `${top2} & ${relevant.length - 2} more` : top2;

    await sendPushToToken(
      user.fcmToken,
      notifTitle,
      notifBody,
      relevant.length
    );
    sent++;
    await new Promise((r) => setTimeout(r, 80));
  }

  console.log(`[JOBS] 📲 Notifications: ${sent} sent, ${skipped} skipped`);
};

// ── Fetch from a single RSS source ───────────────────────────────────────────
const fetchFromRSS = async (source, getJobs) => {
  try {
    console.log(`📡 RSS: ${source.source}`);
    const feed = await rssParser.parseURL(source.url);
    if (!feed?.items || !Array.isArray(feed.items)) {
      console.warn(`⚠️ No items: ${source.source}`);
      return 0;
    }

    const items = feed.items.slice(0, 20);
    let newCount = 0,
      skippedCount = 0;

    for (const item of items) {
      if (!item?.link || !item?.title) continue;
      const titleLower = item.title.toLowerCase();
      if (SKIP_TITLES.some((bad) => titleLower.includes(bad))) {
        skippedCount++;
        continue;
      }
      if (item.title.trim().length < 15) continue;

      const exists = await getJobs().findOne({ applyLink: item.link });
      if (exists) continue;

      const combined = `${item.title} ${item.description || ""}`;
      const description = (item.description || "")
        .replace(/<[^>]*>/g, "")
        .substring(0, 500);

      const job = {
        title: item.title.trim(),
        organization: source.organization,
        // ✅ Use normalizeCategory to ensure correct category
        category: normalizeCategory(
          source.category,
          source.source,
          item.title,
          description
        ),
        exam: mapToExams(item.title, source.exam),
        lastDate: extractLastDate(combined),
        vacancies: extractVacancies(combined),
        salary: "As per govt norms",
        applyLink: item.link,
        description,
        source: source.source,
        postedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        isNew: true,
      };

      await getJobs().insertOne(job);
      newCount++;
    }

    console.log(
      `✅ ${source.source}: ${newCount} new (${skippedCount} skipped)`
    );
    return newCount;
  } catch (err) {
    console.error(`❌ RSS [${source.source}]: ${err.message}`);
    return 0;
  }
};

// ── Fetch from Adzuna API ─────────────────────────────────────────────────────
const fetchFromAdzuna = async (getJobs) => {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;

  if (!appId || !appKey) {
    console.warn("⚠️ ADZUNA_APP_ID / ADZUNA_APP_KEY not set — skipping Adzuna");
    return 0;
  }

  const queries = [
    // ── IT & Software (20) ───────────────────────────────────────────────────
    {
      what: "software engineer",
      category: "it-jobs",
      label: "Software Engineer",
      jobCategory: "private",
    },
    {
      what: "frontend developer react",
      category: "it-jobs",
      label: "Frontend/React",
      jobCategory: "private",
    },
    {
      what: "backend developer nodejs",
      category: "it-jobs",
      label: "Backend/Node",
      jobCategory: "private",
    },
    {
      what: "full stack developer",
      category: "it-jobs",
      label: "Full Stack",
      jobCategory: "private",
    },
    {
      what: "android developer kotlin",
      category: "it-jobs",
      label: "Android Dev",
      jobCategory: "private",
    },
    {
      what: "ios developer swift",
      category: "it-jobs",
      label: "iOS Dev",
      jobCategory: "private",
    },
    {
      what: "devops engineer",
      category: "it-jobs",
      label: "DevOps",
      jobCategory: "private",
    },
    {
      what: "cloud architect AWS Azure",
      category: "it-jobs",
      label: "Cloud",
      jobCategory: "private",
    },
    {
      what: "cybersecurity analyst",
      category: "it-jobs",
      label: "Cybersecurity",
      jobCategory: "private",
    },
    {
      what: "machine learning engineer",
      category: "it-jobs",
      label: "ML Engineer",
      jobCategory: "private",
    },
    {
      what: "data scientist",
      category: "it-jobs",
      label: "Data Scientist",
      jobCategory: "private",
    },
    {
      what: "data analyst python",
      category: "it-jobs",
      label: "Data Analyst",
      jobCategory: "private",
    },
    {
      what: "AI engineer LLM",
      category: "it-jobs",
      label: "AI Engineer",
      jobCategory: "private",
    },
    {
      what: "QA automation tester",
      category: "it-jobs",
      label: "QA/Testing",
      jobCategory: "private",
    },
    {
      what: "database administrator SQL",
      category: "it-jobs",
      label: "DBA",
      jobCategory: "private",
    },
    {
      what: "UI UX designer figma",
      category: "it-jobs",
      label: "UI/UX",
      jobCategory: "private",
    },
    {
      what: "product manager tech startup",
      category: "it-jobs",
      label: "Product Manager",
      jobCategory: "private",
    },
    {
      what: "scrum master agile",
      category: "it-jobs",
      label: "Scrum/Agile",
      jobCategory: "private",
    },
    {
      what: "IT support helpdesk",
      category: "it-jobs",
      label: "IT Support",
      jobCategory: "private",
    },
    {
      what: "blockchain developer web3",
      category: "it-jobs",
      label: "Blockchain",
      jobCategory: "private",
    },

    // ── Finance & Banking (10) ───────────────────────────────────────────────
    {
      what: "chartered accountant CA",
      category: "accounting-finance-jobs",
      label: "CA/Accountant",
      jobCategory: "private",
    },
    {
      what: "financial analyst",
      category: "accounting-finance-jobs",
      label: "Financial Analyst",
      jobCategory: "private",
    },
    {
      what: "investment banker",
      category: "accounting-finance-jobs",
      label: "Investment Banking",
      jobCategory: "private",
    },
    {
      what: "credit analyst bank",
      category: "accounting-finance-jobs",
      label: "Credit Analyst",
      jobCategory: "private",
    },
    {
      what: "tax consultant GST",
      category: "accounting-finance-jobs",
      label: "Tax/GST",
      jobCategory: "private",
    },
    {
      what: "auditor internal external",
      category: "accounting-finance-jobs",
      label: "Auditor",
      jobCategory: "private",
    },
    {
      what: "CFO finance manager",
      category: "accounting-finance-jobs",
      label: "Finance Manager",
      jobCategory: "private",
    },
    {
      what: "stock broker equity research",
      category: "accounting-finance-jobs",
      label: "Equity/Stock",
      jobCategory: "private",
    },
    {
      what: "insurance underwriter",
      category: "accounting-finance-jobs",
      label: "Insurance",
      jobCategory: "private",
    },
    {
      what: "payroll HR finance",
      category: "accounting-finance-jobs",
      label: "Payroll",
      jobCategory: "private",
    },

    // ── Marketing & Sales (10) ───────────────────────────────────────────────
    {
      what: "digital marketing SEO",
      category: "marketing-jobs",
      label: "Digital Marketing",
      jobCategory: "private",
    },
    {
      what: "content writer social media",
      category: "marketing-jobs",
      label: "Content/Social",
      jobCategory: "private",
    },
    {
      what: "sales executive B2B",
      category: "marketing-jobs",
      label: "Sales B2B",
      jobCategory: "private",
    },
    {
      what: "business development manager",
      category: "marketing-jobs",
      label: "Business Dev",
      jobCategory: "private",
    },
    {
      what: "brand manager FMCG",
      category: "marketing-jobs",
      label: "Brand Manager",
      jobCategory: "private",
    },
    {
      what: "growth hacker startup",
      category: "marketing-jobs",
      label: "Growth Hacking",
      jobCategory: "private",
    },
    {
      what: "performance marketing PPC",
      category: "marketing-jobs",
      label: "Performance Mktg",
      jobCategory: "private",
    },
    {
      what: "email marketing CRM",
      category: "marketing-jobs",
      label: "Email/CRM",
      jobCategory: "private",
    },
    {
      what: "PR communications manager",
      category: "marketing-jobs",
      label: "PR/Comms",
      jobCategory: "private",
    },
    {
      what: "ecommerce amazon flipkart",
      category: "marketing-jobs",
      label: "E-Commerce",
      jobCategory: "private",
    },

    // ── Fresher & Graduate (8) ───────────────────────────────────────────────
    {
      what: "fresher engineering graduate",
      category: "graduate-jobs",
      label: "Eng Fresher",
      jobCategory: "private",
    },
    {
      what: "MBA fresher management",
      category: "graduate-jobs",
      label: "MBA Fresher",
      jobCategory: "private",
    },
    {
      what: "internship stipend India",
      category: "graduate-jobs",
      label: "Internship",
      jobCategory: "private",
    },
    {
      what: "trainee program India",
      category: "graduate-jobs",
      label: "Trainee",
      jobCategory: "private",
    },
    {
      what: "campus placement 2025",
      category: "graduate-jobs",
      label: "Campus 2025",
      jobCategory: "private",
    },
    {
      what: "junior analyst entry level",
      category: "graduate-jobs",
      label: "Entry Level",
      jobCategory: "private",
    },
    {
      what: "associate consultant fresher",
      category: "graduate-jobs",
      label: "Associate",
      jobCategory: "private",
    },
    {
      what: "graduate apprentice scheme",
      category: "graduate-jobs",
      label: "Apprentice",
      jobCategory: "private",
    },

    // ── HR & Admin (5) ───────────────────────────────────────────────────────
    {
      what: "HR manager recruiter",
      category: "hr-jobs",
      label: "HR Manager",
      jobCategory: "private",
    },
    {
      what: "talent acquisition HRBP",
      category: "hr-jobs",
      label: "Talent Acquisition",
      jobCategory: "private",
    },
    {
      what: "HR operations payroll",
      category: "hr-jobs",
      label: "HR Ops",
      jobCategory: "private",
    },
    {
      what: "office administrator",
      category: "admin-jobs",
      label: "Admin",
      jobCategory: "private",
    },
    {
      what: "executive assistant PA",
      category: "admin-jobs",
      label: "EA/PA",
      jobCategory: "private",
    },

    // ── Engineering & Manufacturing (8) ─────────────────────────────────────
    {
      what: "mechanical engineer",
      category: "engineering-jobs",
      label: "Mechanical Eng",
      jobCategory: "private",
    },
    {
      what: "civil engineer construction",
      category: "engineering-jobs",
      label: "Civil Eng",
      jobCategory: "private",
    },
    {
      what: "electrical engineer",
      category: "engineering-jobs",
      label: "Electrical Eng",
      jobCategory: "private",
    },
    {
      what: "chemical engineer plant",
      category: "engineering-jobs",
      label: "Chemical Eng",
      jobCategory: "private",
    },
    {
      what: "production manager factory",
      category: "engineering-jobs",
      label: "Production",
      jobCategory: "private",
    },
    {
      what: "quality control engineer",
      category: "engineering-jobs",
      label: "QC Engineer",
      jobCategory: "private",
    },
    {
      what: "supply chain logistics",
      category: "logistics-warehouse-jobs",
      label: "Supply Chain",
      jobCategory: "private",
    },
    {
      what: "operations manager India",
      category: "logistics-warehouse-jobs",
      label: "Operations",
      jobCategory: "private",
    },

    // ── Healthcare & Pharma (5) ──────────────────────────────────────────────
    {
      what: "doctor MBBS hospital",
      category: "healthcare-nursing-jobs",
      label: "Doctor",
      jobCategory: "private",
    },
    {
      what: "nurse staff ANM",
      category: "healthcare-nursing-jobs",
      label: "Nurse",
      jobCategory: "private",
    },
    {
      what: "pharmacist drug store",
      category: "healthcare-nursing-jobs",
      label: "Pharmacist",
      jobCategory: "private",
    },
    {
      what: "medical representative pharma",
      category: "healthcare-nursing-jobs",
      label: "Med Rep",
      jobCategory: "private",
    },
    {
      what: "clinical research CRO",
      category: "healthcare-nursing-jobs",
      label: "Clinical Research",
      jobCategory: "private",
    },

    // ── Education & Training (5) ─────────────────────────────────────────────
    {
      what: "teacher school private",
      category: "teaching-jobs",
      label: "School Teacher",
      jobCategory: "private",
    },
    {
      what: "professor lecturer college",
      category: "teaching-jobs",
      label: "College Lecturer",
      jobCategory: "private",
    },
    {
      what: "edtech content creator",
      category: "teaching-jobs",
      label: "EdTech",
      jobCategory: "private",
    },
    {
      what: "corporate trainer L&D",
      category: "teaching-jobs",
      label: "Corp Trainer",
      jobCategory: "private",
    },
    {
      what: "tutor online coaching",
      category: "teaching-jobs",
      label: "Tutor/Coaching",
      jobCategory: "private",
    },

    // ── Legal & Compliance (3) ───────────────────────────────────────────────
    {
      what: "lawyer advocate corporate",
      category: "legal-jobs",
      label: "Lawyer",
      jobCategory: "private",
    },
    {
      what: "compliance officer SEBI RBI",
      category: "legal-jobs",
      label: "Compliance",
      jobCategory: "private",
    },
    {
      what: "paralegal legal assistant",
      category: "legal-jobs",
      label: "Paralegal",
      jobCategory: "private",
    },

    // ── Media & Creative (4) ─────────────────────────────────────────────────
    {
      what: "journalist reporter news",
      category: "creative-design-jobs",
      label: "Journalist",
      jobCategory: "private",
    },
    {
      what: "graphic designer photoshop",
      category: "creative-design-jobs",
      label: "Graphic Designer",
      jobCategory: "private",
    },
    {
      what: "video editor motion graphics",
      category: "creative-design-jobs",
      label: "Video Editor",
      jobCategory: "private",
    },
    {
      what: "copywriter content strategist",
      category: "creative-design-jobs",
      label: "Copywriter",
      jobCategory: "private",
    },

    // ── Retail & Hospitality (4) ─────────────────────────────────────────────
    {
      what: "hotel manager hospitality",
      category: "hospitality-catering-jobs",
      label: "Hospitality",
      jobCategory: "private",
    },
    {
      what: "retail store manager",
      category: "retail-jobs",
      label: "Retail",
      jobCategory: "private",
    },
    {
      what: "customer service BPO",
      category: "customer-services-jobs",
      label: "Customer Service",
      jobCategory: "private",
    },
    {
      what: "call center agent voice",
      category: "customer-services-jobs",
      label: "BPO/Call Center",
      jobCategory: "private",
    },

    // ── Real Estate & Construction (3) ───────────────────────────────────────
    {
      what: "real estate sales property",
      category: "property-jobs",
      label: "Real Estate",
      jobCategory: "private",
    },
    {
      what: "architect interior designer",
      category: "property-jobs",
      label: "Architect",
      jobCategory: "private",
    },
    {
      what: "project manager construction",
      category: "property-jobs",
      label: "Project Manager",
      jobCategory: "private",
    },

    // ── Remote Jobs (5) — ✅ jobCategory: "remote" ────────────────────────
    {
      what: "remote software engineer India",
      category: "it-jobs",
      label: "Remote SWE",
      jobCategory: "remote",
    },
    {
      what: "remote work from home India",
      category: "it-jobs",
      label: "Remote India",
      jobCategory: "remote",
    },
    {
      what: "remote data analyst India",
      category: "it-jobs",
      label: "Remote Data",
      jobCategory: "remote",
    },
    {
      what: "remote content writer India",
      category: "marketing-jobs",
      label: "Remote Content",
      jobCategory: "remote",
    },
    {
      what: "remote customer support India",
      category: "customer-services-jobs",
      label: "Remote Support",
      jobCategory: "remote",
    },

    // ── Startup (3) ──────────────────────────────────────────────────────────
    {
      what: "startup CTO technical lead",
      category: "it-jobs",
      label: "Startup CTO",
      jobCategory: "private",
    },
    {
      what: "SaaS account executive",
      category: "sales-jobs",
      label: "SaaS Sales",
      jobCategory: "private",
    },
    {
      what: "venture capital analyst",
      category: "accounting-finance-jobs",
      label: "VC Analyst",
      jobCategory: "private",
    },
  ];

  let newCount = 0;

  for (const q of queries) {
    try {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        what: q.what,
        where: "India",
        results_per_page: "10",
        sort_by: "date",
        category: q.category,
      });

      const res = await fetch(
        `https://api.adzuna.com/v1/api/jobs/in/search/1?${params}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!res.ok) {
        console.warn(`⚠️ Adzuna [${q.label}] HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const results = data?.results || [];

      for (const item of results) {
        if (!item?.redirect_url || !item?.title) continue;

        const titleLower = item.title.toLowerCase();
        if (SKIP_TITLES.some((bad) => titleLower.includes(bad))) continue;

        const exists = await getJobs().findOne({
          applyLink: item.redirect_url,
        });
        if (exists) continue;

        const salary = item.salary_min
          ? `₹${Math.round(item.salary_min / 100000)}L – ₹${Math.round(
              (item.salary_max || item.salary_min * 1.5) / 100000
            )}L`
          : "As per company norms";

        const description = (item.description || "")
          .replace(/<[^>]*>/g, "")
          .substring(0, 500);

        const job = {
          title: item.title.trim(),
          organization: item.company?.display_name || "Indian Company",
          category: q.jobCategory || "private", // ✅ use per-query jobCategory
          exam: ["General"],
          lastDate: "See official site",
          vacancies: "N/A",
          salary,
          location: item.location?.display_name || "India",
          applyLink: item.redirect_url,
          description,
          source: "Adzuna",
          postedAt: item.created ? new Date(item.created) : new Date(),
          isNew: true,
        };

        await getJobs().insertOne(job);
        newCount++;
      }

      console.log(`✅ Adzuna [${q.label}]: ${results.length} fetched`);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`❌ Adzuna [${q.label}]:`, err.message);
    }
  }

  console.log(`✅ Adzuna total: ${newCount} new jobs`);
  return newCount;
};

// ── Mark jobs older than 2 days as not-new ────────────────────────────────────
const markOldJobs = async (getJobs) => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await getJobs().updateMany(
    { isNew: true, postedAt: { $lt: twoDaysAgo } },
    { $set: { isNew: false } }
  );
};

// ── Cleanup: remove junk + keep only latest 2000 ─────────────────────────────
const cleanupJobs = async (getJobs) => {
  try {
    const skipRegex = SKIP_TITLES.join("|");
    const del1 = await getJobs().deleteMany({
      title: { $regex: skipRegex, $options: "i" },
    });
    if (del1.deletedCount > 0)
      console.log(`🧹 Removed ${del1.deletedCount} junk posts`);
  } catch (err) {
    console.warn("⚠️ Junk cleanup failed:", err.message);
  }

  try {
    const keepIds = await getJobs()
      .find({})
      .sort({ postedAt: -1 })
      .limit(2000)
      .project({ _id: 1 })
      .toArray()
      .then((docs) => docs.map((d) => d._id));
    const del2 = await getJobs().deleteMany({ _id: { $nin: keepIds } });
    if (del2.deletedCount > 0)
      console.log(`🧹 Cleaned ${del2.deletedCount} old jobs`);
  } catch (err) {
    console.warn("⚠️ Old job cleanup failed:", err.message);
  }
};

// ── Fix existing misclassified jobs in DB (run once on startup) ───────────────
export const fixExistingJobCategories = async (getJobs) => {
  try {
    // Fix remote RSS sources misclassified as international
    const r1 = await getJobs().updateMany(
      { source: { $in: ["RemoteOK", "We Work Remotely", "Jobicy"] } },
      { $set: { category: "remote" } }
    );

    // Fix Adzuna jobs with remote keywords misclassified as private
    const r2 = await getJobs().updateMany(
      {
        source: "Adzuna",
        $or: [
          { title: { $regex: "remote", $options: "i" } },
          { description: { $regex: "work from home", $options: "i" } },
          { description: { $regex: "\\bwfh\\b", $options: "i" } },
        ],
      },
      { $set: { category: "remote" } }
    );

    const total = r1.modifiedCount + r2.modifiedCount;
    if (total > 0)
      console.log(
        `✅ Fixed ${total} misclassified jobs (${r1.modifiedCount} RSS + ${r2.modifiedCount} Adzuna → remote)`
      );
  } catch (err) {
    console.warn("⚠️ Category fix failed:", err.message);
  }
};

// ── Main runner ───────────────────────────────────────────────────────────────
export const runJobFetcher = async (getJobs, getUsers) => {
  const today = new Date().toISOString().split("T")[0];
  const alreadyFetched = await getJobs().findOne({
    _fetchDate: today,
    _isMeta: true,
  });
  if (alreadyFetched) {
    console.log(`[JOBS] Already fetched today (${today}) — skipping`);
    return;
  }
  const fetchStart = new Date();
  console.log("\n🚀 Job fetcher started at", fetchStart.toISOString());

  // Fix any existing misclassified jobs first
  await fixExistingJobCategories(getJobs);

  const rssResults = await Promise.all(
    RSS_SOURCES.map((src) => fetchFromRSS(src, getJobs))
  );
  const rssTotal = rssResults.reduce((a, b) => a + b, 0);

  const adzunaTotal = await fetchFromAdzuna(getJobs);
  const total = rssTotal + adzunaTotal;

  console.log(
    `[JOBS] RSS: ${rssTotal} new | Adzuna: ${adzunaTotal} new | Total: ${total}`
  );

  await markOldJobs(getJobs);
  await cleanupJobs(getJobs);
  await getJobs().insertOne({
    _fetchDate: today,
    _isMeta: true,
    fetchedAt: new Date(),
    total,
  });

  console.log(`\n✅ Fetch complete. ${total} new jobs added.`);

  if (total > 0) await sendJobNotifications(getJobs, getUsers, fetchStart);
};

// ── Cron: once daily at 6:00 PM IST (12:30 UTC) ──────────────────────────────
export const startJobCron = (getJobs, getUsers) => {
  cron.schedule(
    "30 12 * * *",
    async () => {
      console.log(
        "[JOBS] ⏰ 6 PM IST cron triggered —",
        new Date().toISOString()
      );
      await runJobFetcher(getJobs, getUsers);
    },
    { timezone: "UTC" }
  );

  console.log("✅ Job cron scheduled — 6:00 PM IST daily");
};
