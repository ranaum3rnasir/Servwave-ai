// ServWave canonical icon set.
//
// Source of truth: `src/assets/servewave_icon_board.svg` — the "ServWave Icon
// Library" board (Clean. Connected. Intelligent.). That board is a flattened
// raster reference, not a set of importable files; this module is its
// machine-usable form. Each board glyph is realised with the matching
// `lucide-react` vector (same line/Feather drawing style), so icons stay sharp,
// recolourable, and theme-aware (Ocean / Sage / lavender) at any size.
//
// Surfaces should pull their icons from here so the app stays 1:1 with the
// board. The board defines ~45 icons across four groups; icons outside the board
// (the long tail used across the app) keep their existing lucide choices.
//
// ───────────────────────── Board → lucide mapping ──────────────────────────
//  CORE NAVIGATION
//    Dashboard ........ BarChart3        Schedule ......... CalendarDays
//    Leads ............ Filter (funnel)  Payments ......... CircleDollarSign
//    Customers ........ User             Invoices ......... Receipt
//    Estimates ........ FileText         Marketing ........ Megaphone
//    Jobs ............. Briefcase        Settings ......... Settings
//  INTELLIGENCE & INSIGHTS
//    Revenue Analytics .. TrendingUp     Customer Journey ...... Route
//    Opportunity Engine . Search         Performance Score ..... Gauge
//    Business Health .... Activity       Profitability Analysis  PieChart
//    Growth Insights .... Sprout         Risk Monitor .......... Shield
//    Marketing Attribution Shuffle       Job Profitability ..... PieChart
//  AI CENTER (one glyph per AI category)
//    AI Sales ..... Phone               AI HR ............ CircleUser
//    AI Marketing . MessageCircle       AI Bookkeeping ... Calculator
//    AI Finance ... BadgeDollarSign     AI Automation .... Zap
//    AI Operations  SlidersHorizontal   20+ Agents ....... Users
//  OTHER ESSENTIALS
//    Messages MessageSquare  Notifications Bell      Upload  Upload
//    Calls    Phone          Profile       CircleUser Add New PlusCircle
//    Email    Mail           Search        Search    View    Eye
//    Map      MapPin         Filter        Filter    Edit    Pencil
//    Documents Paperclip     Download      Download  Delete  Trash2
// ─────────────────────────────────────────────────────────────────────────────

import {
  // Core navigation
  BarChart3, Filter, User, FileText, Briefcase, CalendarDays,
  CircleDollarSign, Receipt, Megaphone, Settings,
  // Intelligence & insights
  TrendingUp, Search, Activity, Sprout, Shuffle, PieChart, Route, Gauge, Shield,
  // AI center (per category)
  Phone, MessageCircle, BadgeDollarSign, SlidersHorizontal, CircleUser,
  Calculator, Zap, Users, Radar, Crown,
  // Other essentials
  MessageSquare, Mail, MapPin, Paperclip, Bell, Download, Upload, PlusCircle,
  Eye, Pencil, Trash2,
  type LucideIcon,
} from 'lucide-react';

/** Board group: Core Navigation. */
export const coreNavIcons = {
  dashboard: BarChart3,
  leads: Filter,
  customers: User,
  estimates: FileText,
  jobs: Briefcase,
  schedule: CalendarDays,
  payments: CircleDollarSign,
  invoices: Receipt,
  marketing: Megaphone,
  settings: Settings,
} satisfies Record<string, LucideIcon>;

/** Board group: Intelligence & Insights. */
export const insightIcons = {
  revenueAnalytics: TrendingUp,
  opportunityEngine: Search,
  businessHealth: Activity,
  growthInsights: Sprout,
  marketingAttribution: Shuffle,
  jobProfitability: PieChart,
  customerJourney: Route,
  performanceScore: Gauge,
  profitabilityAnalysis: PieChart,
  riskMonitor: Shield,
} satisfies Record<string, LucideIcon>;

/** Board group: AI Center — one glyph per AI category. */
export const aiCategoryIcons = {
  sales: Phone,
  marketing: MessageCircle,
  finance: BadgeDollarSign,
  operations: SlidersHorizontal,
  hr: CircleUser,
  bookkeeping: Calculator,
  automation: Zap,
  people: Users,
  salesIntelligence: Radar,
  master: Crown,
} satisfies Record<string, LucideIcon>;

/** Board group: Other Essentials — common actions & comms. */
export const essentialIcons = {
  messages: MessageSquare,
  calls: Phone,
  email: Mail,
  map: MapPin,
  documents: Paperclip,
  notifications: Bell,
  profile: CircleUser,
  search: Search,
  filter: Filter,
  download: Download,
  upload: Upload,
  addNew: PlusCircle,
  view: Eye,
  edit: Pencil,
  delete: Trash2,
} satisfies Record<string, LucideIcon>;
