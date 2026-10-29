// Barrel for the Communication mock seed layer. The data seam
// (lib/api/communication.ts) imports from this single path; pages/components
// must never import from _mock directly (data-seam discipline).

export * from "./phone-calls";
export * from "./phone-customers";
export * from "./phone-agents";
export * from "./phone-messages";
export * from "./messageDelivery";
export * from "./phone-numbers";
export * from "./phone-texting";
export * from "./phone-blocked";
export * from "./phone-training";
export * from "./whatsapp";
export * from "./email";
export * from "./call-config";
