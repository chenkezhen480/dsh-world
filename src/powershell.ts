/**
 * Text as one PowerShell single-quoted string, where nothing is expanded. PowerShell takes the curly single quotes
 * (U+2018 to U+201B) for quotes as well, so each is doubled like the straight one; a path such as `C:\Users\O’Neil`
 * would otherwise end the string early.
 */
export const quotePowerShell = (text: string) => `'${text.replace(/['\u2018-\u201B]/g, '$&$&')}'`;
