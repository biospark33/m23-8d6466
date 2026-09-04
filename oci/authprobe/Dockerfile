# The AC4 negative-control probe image. NOT a boot image — it is never meant to
# run, and `FROM scratch` guarantees it cannot.
#
# WHY IT EXISTS (2026-09-03 live round): AC4's negative leg proves that an
# unauthenticated create of a PRIVATE image is refused. It used to point at
# `qds-exedev-private`, whose digest is derived from the public pin
# (`DEFAULT_IMAGE_REF.split("@")[1]`) and is therefore the SAME digest every
# other live test boots. exe.dev's host-side pull is content-addressed, so the
# first round to boot the public pin warms that digest substrate-wide and every
# later unauthenticated create of the "private" ref short-circuits the pull and
# SUCCEEDS — proven 4/4 at 2-3 s against an 86 s cold authenticated pull of the
# same digest. The leg passed on 2026-09-02 only because the pin had moved that
# day, i.e. it was honest for exactly one cold window per re-pin.
#
# THE INVARIANT THAT MAKES THIS IMAGE WORK: a refused pull caches nothing. This
# image is used ONLY on the negative leg, where the create is expected to fail,
# so its digest never enters the substrate cache and the leg stays honest
# indefinitely — no per-round rebuild, no re-push ritual.
#
# THEREFORE, THE ONE RULE: never create a box from this ref WITH credentials. A
# successful authenticated pull would warm its digest and silently convert the
# negative leg back into the false green this image exists to prevent.
FROM scratch
COPY marker.txt /qds-authprobe-marker
