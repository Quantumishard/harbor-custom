# Easynews NZB playback through Harbor's AIOStreams connection

This extends the existing AIOStreams library integration. It preserves the original
Easynews HTTP stream and adds **Easynews NZB via AIOStreams** on desktop for direct
Easynews results containing the account and file identity. The existing Worker NZB
choice, if present, remains separate and still uses the Worker's configured instance.

## Use

1. Open **Library → AIOStreams** in Harbor.
2. Enter your private instance's base URL. For ElfHosted, use **Open sign-in window**,
   complete the hosting and dashboard logins, and connect the library. Enable
   **Remember sign-in** if desired. Existing remembered sessions can be restored.
3. Search with your Easynews addon and refresh the source list.
4. Select the choice labeled **NZB via AIOStreams**. Harbor retrieves the NZB from
   Easynews, uploads it using the authenticated library session, waits for inspection,
   selects the matching video, and opens the existing local playback relay.
5. The original HTTP choice is still available. No Worker secret or deployment
   change is needed for this Harbor path.

Only native desktop clients add these choices; browser clients are unchanged.
The primary ranked choice remains unchanged. Automatic resolution without a manual
commit does not start an NZB import. Remembered playback selections can still be
explicitly committed by Harbor's continuation flow.

## Behavior and limits

- There is **no fixed 16 MiB NZB size cap** in this Harbor implementation. AIOStreams
  and the hosting proxy may impose their own upload limits.
- Retrieval and import have a shared 90-second timeout. Individual network requests
  retain the existing native client's timeouts.
- Cancelling or leaving the picker cancels the native request. An upload already
  accepted by AIOStreams may remain in its library; cancellation does not delete it.
- One matching video is selected automatically. If several playable files are
  ambiguous, choose the file manually under **Library → AIOStreams**.
- Supported Easynews download URLs are validated in both frontend and Rust. Easynews
  credentials are sent only to its initial API origin. Redirect destinations must
  stay on HTTPS Easynews servers; cross-origin redirects cannot carry POST data.
- Hosting cookies remain in the native AIOStreams session. They are never sent to
  Easynews, exposed to addons, or passed to the player. The established relay keeps
  byte-range requests and safe storage redirects working.
- The new handoff returns only a local relay URL to the interface. It logs no source
  URLs, session cookies, provider credentials, or raw upstream errors.
- An aggregator that rewrites or proxies the original Easynews HTTP URL may hide
  the file identity needed for retrieval. Use the existing passthrough settings or
  install the Easynews addon directly. Ordinary results without catalog signatures
  use Easynews's signature-optional retrieval form.

## Validation

Automated tests cover option generation, keeping HTTP and primary ranking, session
requirements, cancellation, host validation, XML validation, ambiguous file handling,
authenticated multipart upload, library inspection, and HTTP 206 playback through
the existing relay. Live ElfHosted upload still needs a test on the user's instance;
the earlier integration confirmed authenticated library browsing and playback.

The source starts from the custom build containing remembered sign-in, safe
AIOStreams playback redirects, thumbnail recovery, combined TorBox date sorting,
and prior custom metadata/player updates. No rclone or disc mount is introduced.
