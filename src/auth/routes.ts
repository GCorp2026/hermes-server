// Re-export all handlers from split files for backwards compatibility
export {
  handleAuthRegister,
  handleAuthLogin,
  handleGetUserRoles,
  handleAuthMe,
  handlePromoteToAdmin,
  handleValidateToken,
  json,
  error,
} from './1-auth.core';

export {
  handleAdminListUsers,
  handleAdminSetRole,
  handleAdminDeleteUser,
  handleAdminBulkDelete,
  handleAdminBulkUpdate,
  handleAdminUpdateUser,
  handleAdminResetPassword,
} from './2-auth.admin';

export {
  handleAdminListEmailAssignments,
  handleAdminCreateEmailAssignment,
  handleAdminDeleteEmailAssignment,
} from './3-auth.email-assignments';

export {
  handleGetWorkEmails,
  handleGetEmailHistory,
  handleEmailHistoryRecent,
  handleDeleteEmailHistory,
  handleRefetchEmailContent,
} from './4-auth.email-history';

export {
  handleHermesEmailSend,
  handleProcessScheduled,
  handleResendWebhook,
} from './5-auth.email-send';

export {
  handleTranslate,
} from './6-auth.translate';
