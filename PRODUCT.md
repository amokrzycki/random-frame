# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop (Tauri with a web UI)

## Stack

Tauri 2 desktop application with a plain HTML, CSS and TypeScript interface and a Rust backend. The backend resolves public Prnt.sc images because the source blocks cross-origin framing.

## Users

People casually exploring surprising public images in a focused, single-item gallery.

## Product Purpose

Random Frame is intended to aggregate random public media from selectable sources while showing one item at a time. Visitors can move back through the current session, draw a new result, and save the displayed image.

## Positioning

Instead of an endless feed, Random Frame offers one deliberate draw at a time across public media archives.

## Operating Context

The gallery is used as a focused desktop utility in a resizable window, primarily with keyboard and mouse. Its browsing history is intentionally temporary and is cleared when the application reloads.

## Capabilities and Constraints

- The current implementation uses Prnt.sc and its six-character lowercase alphanumeric identifiers.
- Imgur is not a planned provider because new developer accounts cannot currently be registered.
- Wikimedia Commons, Internet Archive, and other sources with accessible APIs remain candidates; provider choice, selection rules, attribution, moderation, and mixed-source behavior are open decisions for the next planning phase.
- Prnt.sc blocks cross-origin framing, so the current app resolves and proxies its public image through the server.
- Previous/next navigation and direct image download are required.
- The current Prnt.sc mode can inspect the immediately adjacent base-36 identifiers; successful results join the temporary history.
- The upstream service may rate-limit or block repeated requests; errors must be recoverable without losing earlier history.

## Brand Commitments

The working product name is Random Frame. The interface should feel simple, quiet, and lightly premium. Polish must not compete with the displayed media.

## Evidence on Hand

The supplied Chris Hannah implementation establishes the current Prnt.sc identifier format and warns about rate limiting. Imgur was ruled out because new developer accounts cannot currently be registered. No replacement-provider research, logo, proprietary artwork, performance claim, or commercial proof was supplied.

## Product Principles

- The displayed media is always the focal point.
- One clear action advances exploration; history stays effortless.
- Temporary means temporary: no durable browsing record.
- Every item keeps a clear link to its source.
- Upstream failures are explained plainly and recover gracefully.

## Accessibility & Inclusion

All actions must be keyboard accessible, have visible focus, and expose loading and error state to assistive technology.
