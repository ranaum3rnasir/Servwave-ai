export type JobStatus =
  | "Unscheduled" | "Scheduled" | "In progress" | "Completed" | "Cancelled";

export interface Job {
  id: string;
  number: string;
  /** Secondary reference shown under the job number. */
  reference: string;
  customer: string;
  location: string;
  status: JobStatus;
  assignees: string[];
  scheduledAt: string | null;
  createdAt: string;
}

/** Swap for your API. Mirrors the first page of the ServWave demo dataset. */
export const jobs: Job[] = [
  { id: "1",  number: "J00225", reference: "d00150", customer: "QA Chain1784333186",   location: "123 QA Way, Springfield",   status: "Completed",   assignees: [], scheduledAt: null, createdAt: "2026-07-18" },
  { id: "2",  number: "J00224", reference: "d00132", customer: "AddLoc-0715b",         location: "200 Second Blvd, Austin",   status: "Cancelled",   assignees: [], scheduledAt: null, createdAt: "2026-07-15" },
  { id: "3",  number: "J00223", reference: "d00131", customer: "JobFork Customer-0715b", location: "3 Test Blvd, Austin",     status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-07-15" },
  { id: "4",  number: "J00222", reference: "d00129", customer: "JobLink Customer-0715b", location: "2 Test Ave, Austin",      status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-07-15" },
  { id: "5",  number: "J00221", reference: "d00128", customer: "QA-Job-Co-0715b",      location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-07-15" },
  { id: "6",  number: "J00220", reference: "d00124", customer: "QA-Job-Co-0715a",      location: "1 Test Street, El Paso",    status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-07-15" },
  { id: "7",  number: "J00219", reference: "d00124", customer: "QA-Job-Co-0715a",      location: "1 Test Street, El Paso",    status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-07-15" },
  { id: "8",  number: "J00218", reference: "d00117", customer: "Emanuel Test",         location: "1001 Willow Ave, Hoboken",  status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-07-13" },
  { id: "9",  number: "J00217", reference: "d00115", customer: "Dome Test",            location: "1001 Willow Ave, Hoboken",  status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-07-13" },
  { id: "10", number: "J00212", reference: "d00096", customer: "test",                 location: "1001 Willow Ave, Hoboken",  status: "Scheduled",   assignees: ["Lena Ortiz"], scheduledAt: "2026-07-12", createdAt: "2026-07-11" },
  { id: "11", number: "J00211", reference: "d00104", customer: "ZZ TEST JobAudit Alpha", location: "77 ZZ Test Ave, Hoboken", status: "Scheduled",   assignees: ["Test Technician"], scheduledAt: "2026-07-20", createdAt: "2026-07-10" },
  { id: "12", number: "J00209", reference: "d00104", customer: "ZZ TEST JobAudit Alpha", location: "77 ZZ Test Ave, Hoboken", status: "Cancelled",   assignees: ["Mike Alvarez"], scheduledAt: "2026-07-16", createdAt: "2026-07-10" },
  { id: "13", number: "J00208", reference: "d00102", customer: "ZZ TEST LeadAudit",    location: "123 ZZ Test St, Hoboken",   status: "Unscheduled", assignees: ["Test Technician", "Carlos Tran"], scheduledAt: null, createdAt: "2026-07-10" },
  { id: "14", number: "J00207", reference: "d00102", customer: "ZZ TEST LeadAudit",    location: "123 ZZ Test St, Hoboken",   status: "Unscheduled", assignees: ["Dre Patel"], scheduledAt: null, createdAt: "2026-07-10" },
  { id: "15", number: "J00205", reference: "d00036", customer: "Linda Allen",          location: "1751 Maple Dr, Trenton",    status: "Scheduled",   assignees: ["System Admin"], scheduledAt: "2026-07-08", createdAt: "2026-07-05" },
  { id: "16", number: "J00192", reference: "d00079", customer: "QA regrmqjvmd00-8",    location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "17", number: "J00191", reference: "d00082", customer: "QA sparemqjvnh3e-11",  location: "1 Test St, Austin",         status: "Scheduled",   assignees: [], scheduledAt: "2026-06-29", createdAt: "2026-06-19" },
  { id: "18", number: "J00190", reference: "d00083", customer: "QA sparemqjvnlhu-12",  location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "19", number: "J00189", reference: "d00080", customer: "QA notifFmqjvmpkr-9",  location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "20", number: "J00188", reference: "d00077", customer: "QA deppaidmqjvm1jh-6", location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "21", number: "J00187", reference: "d00078", customer: "QA idemmqjvm8jt-7",    location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "22", number: "J00186", reference: "d00062", customer: "QA Fixmqjvf8u2-1",     location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "23", number: "J00185", reference: "d00072", customer: "QA emptymqjvl5j9-1",   location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "24", number: "J00184", reference: "d00036", customer: "Linda Allen",          location: "1751 Maple Dr, Trenton",    status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-19" },
  { id: "25", number: "J00183", reference: "d00085", customer: "QA mixedRmqjvwkyv-1",  location: "1 Test St, Austin",         status: "Unscheduled", assignees: [], scheduledAt: null, createdAt: "2026-06-18" },
];

export interface JobMetric {
  key: JobStatus | "needInvoices";
  label: string;
  value: string;
  hint?: string;
}

export const jobMetrics: JobMetric[] = [
  { key: "Unscheduled", label: "Unscheduled", value: "20" },
  { key: "Scheduled", label: "Scheduled", value: "39" },
  { key: "In progress", label: "In progress", value: "4" },
  { key: "Completed", label: "Completed", value: "0", hint: "This month" },
  { key: "Cancelled", label: "Cancelled", value: "1", hint: "This month" },
  { key: "needInvoices", label: "Need invoices", value: "22", hint: "Completed, unbilled" },
];
