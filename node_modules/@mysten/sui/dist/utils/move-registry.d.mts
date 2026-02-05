//#region src/utils/move-registry.d.ts
declare const isValidNamedPackage: (name: string) => boolean;
/**
 * Checks if a type contains valid named packages.
 * This DOES NOT check if the type is a valid Move type.
 */
declare const isValidNamedType: (type: string) => boolean;
//#endregion
export { isValidNamedPackage, isValidNamedType };
//# sourceMappingURL=move-registry.d.mts.map