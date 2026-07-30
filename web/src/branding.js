/**
 * Product naming, kept in one place so it can be changed without hunting through
 * components.
 *
 * "Chorus" rather than anything with "agent" in it: the app routes a
 * conversation to one of several models, but the models do not call tools or run
 * autonomous loops, so calling them agents would oversell what this does.
 */

/** Product name shown in the header, login screen and document title. */
export const APP_NAME = 'Chorus';

/** One-line description shown under the product name. */
export const APP_TAGLINE = 'Many models. One conversation.';

/** Longer description used on the sign-in screen. */
export const APP_DESCRIPTION = 'Private multi-model chat on Amazon Bedrock.';
