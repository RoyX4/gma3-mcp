# MVR asset identity

MVR inspection always retains an asset's exact `sha256` and byte length. For an embedded GDTF that is a readable ZIP, it additionally reports `contentHashKind: "zip-members-sha256-v1"` and `contentSha256`.

This content identity covers every regular nested member's normalized path and uncompressed bytes. Paths are sorted by their UTF-8 bytes. The hash starts with the algorithm tag and frames each path and payload with an unsigned 8-byte big-endian length. Explicit empty directory records, timestamps, ZIP entry order, compression choices and container comments do not change content identity. Changing a file path or any payload byte does. XML bytes are not rewritten or normalized, and referenced meshes are not interpreted.

The reader validates all nested members without extracting them. It rejects unsafe paths, case-insensitive duplicate paths, encrypted entries, symlinks, oversized members and invalid payload reads. Across all embedded GDTFs, inspection permits at most 20,000 nested entries and 512 MiB of declared uncompressed content; each member is at most 128 MiB. Native GDTF compatibility is a separate claim.

An opaque, non-ZIP GDTF can still be inventoried for compatibility with existing inspection callers. It has `contentHashUnavailable` and only raw byte identity. `mvrAssetIdentity` uses the content hash only with the recognized algorithm and a complete SHA-256; incomplete declared content proof fails. Legacy or opaque assets retain their exact raw hash.

`compareMvr().assets.changed` compares these content identities. `containerChanged` separately retains the list of exact asset files whose raw SHA changed, including packages changed only by timestamps. Fixture import planning and verification record the selected identity algorithm; a semantic-content match does not claim that the compressed asset files are byte-identical.

Regression checks: `node --import tsx --test test/mvr-assets.test.ts test/mvr.test.ts`.
