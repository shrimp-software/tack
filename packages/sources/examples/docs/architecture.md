# Architecture

Tack discovers tools from sources, folds them into one manifest, and exposes
`execute` and `guide` over MCP.

A source is either an MCP server or a local module. Both produce the same
`DiscoveredServer` shape before the manifest is built.
