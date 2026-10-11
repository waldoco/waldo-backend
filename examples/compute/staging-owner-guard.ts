/** Source roster is not a credential. It confines paid staging calls to one reviewed physical owner scope. */
export function requireStagingComputeOwner(scopes: readonly string[], ownerScope: string): void {
  if (scopes.length !== 1 || !scopes[0] || typeof ownerScope !== 'string' || scopes[0] !== ownerScope) {
    throw new Error('Staging compute owner is not admitted');
  }
}
