// Beta settings appear in every build except prod, where they are hidden and have no effect.
export const betaSettingsAvailable = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"
