The version-specific Weixin ABI facts and native message-construction approach
were researched using Prometheus-first/helper (native/core_version.h,
native/selftest_bridge.cpp, native/text_bridge.cpp, native/image_send.h and
native/emoticon_send.h). See the adjacent LICENSE for that project's
noncommercial terms. This directory is separately licensed, not covered by
the MIT license at the dsh-world repository root.

This is a tailored send-only bridge. It has its own request ABI and lifecycle;
it does not include helper's bot framework, model, user interface, receive
hooks, recall handling, account discovery or group management.

profiles.json contains the fingerprint-locked 4.1.15.13, 4.1.15.56, 4.2.0.11 and 4.2.0.12
address mappings from https://github.com/Prometheus-first/helper/blob/main/native/core_version.h.

The 4.2.0.13 mapping was derived by dsh-world from the Tencent-signed Windows
x64 Weixin.dll. The comparison used the 4.2.0.12 DLL extracted from Tencent's
installer and verified against the existing profile. Function disassembly,
references to the account root, and the context vtable were compared between
the two builds.
