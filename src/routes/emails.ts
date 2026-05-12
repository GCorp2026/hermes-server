// Re-export all email handlers for backward compatibility with index.ts imports
export { PIXEL, json, error, handleWorkEmails, createWorkEmail, handleEmailHistory, handleScheduledEmails, handleSendEmail } from "./emails/core";
export { handleEmailLabels, createEmailLabel, deleteEmailLabel, handleLabelAssignments, createLabelAssignment, deleteLabelAssignment } from "./emails/labels";
export { listTemplates, createTemplate, updateTemplate, deleteTemplate } from "./emails/templates";
export { handleTrackEmailOpen, handleTrackEmailClick } from "./emails/tracking";
