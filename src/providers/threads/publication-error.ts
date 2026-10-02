/** An external publication may exist; automatically repeating it is unsafe. */
export class ThreadsPublicationUncertainError extends Error {
  public constructor(public readonly providerPostId?: string) {
    super(
      providerPostId
        ? `Threads published post ${providerPostId}, but local history could not be saved. Do not publish it again.`
        : 'Threads may have accepted this post, but publication could not be confirmed. Check the account before publishing it again.',
    );
    this.name = 'ThreadsPublicationUncertainError';
  }
}
