// Keep the last successful Home summary while switching tabs. Home still
// refetches on mount; this stops its shipment count swapping with placeholder
// copy during that request. Scope the snapshot to the signed-in account.
let homeSnapshot = null;

export const readCustomerHome = (userId) =>
  userId && homeSnapshot?.userId === userId ? homeSnapshot : null;

export const saveCustomerHome = (userId, fields) => {
  if (!userId) return;
  homeSnapshot = { ...(readCustomerHome(userId) || {}), ...fields, userId };
};

export const clearCustomerPageCache = () => {
  homeSnapshot = null;
};
