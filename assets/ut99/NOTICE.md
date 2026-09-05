# Unreal Tournament (1999) HUD and weapon textures

The PNG files in this directory are textures from Epic Games' *Unreal
Tournament* (1999): `BotPack.Icons.HudElements1`, `BotPack.Icons.HUDWeapons`,
`BotPack.Icons.Man` and `BotPack.Icons.ManBelt`, exported unchanged from a
retail installation.

Since the first-person weapons gained UT99's own firing feel, so are the two
weapons' **muzzle flashes**: `BotPack.Skins.Muz1` through `Muz5` (the five
variations the Enforcer picks from at random on every render) and
`BotPack.Rifle.MuzzleFlash2` (the Sniper Rifle's). They are extracted by
`scripts/build-ut-viewmodels.mjs`; the other four weapons have no `MFTexture`
and draw no flash at all.

They are copyright Epic Games, Inc. and are **not** covered by this
repository's licence. They are used here, without a licence, for a
non-commercial fan recreation of CTF-Face, in the same spirit as the UT99
community's own mods and remakes. If you are the rights holder and want them
removed, open an issue; the site renders the same HUD from its own SVG/CSS
recreation with `GAME_CONFIG.HUD.ATLAS = false`.
