# Attribution and third-party notices

OpenMTP was created by [Ganesh Rathinavel](https://github.com/ganeshrvel). This development fork derives from [ganeshrvel/openmtp](https://github.com/ganeshrvel/openmtp), with upstream revision `5da350b69c6d0d4aed67a063498ee89c7448400a` as its recorded starting point. The root [MIT license](../LICENSE) and its original copyright notice are unchanged. The original README also states: Copyright © 2018-Present Ganesh Rathinavel.

Upstream resources: [website](https://openmtp.ganeshrvel.com/), [device-connection guide](https://openmtp.ganeshrvel.com/how-to-connect-devices.html), [FAQ](https://openmtp.ganeshrvel.com/#faq), [releases](https://github.com/ganeshrvel/openmtp/releases), [author](https://www.ganeshrvel.com/). Upstream contact: ganeshrvel@outlook.com. These identify the original project, not a support or release commitment from this fork.

Upstream support links: [PayPal](https://paypal.me/ganeshrvel), [Buy Me a Coffee](https://buymeacoffee.com/ganeshrvel). These support the original author.

## Original project credits

The following credits are retained from the upstream README:

- Special thanks to [CodeMagic](http://codemagic.io/ 'Codemagic - CI/CD') and [Kevin Suhajda](https://www.linkedin.com/in/kevinsuhajda 'Kevin Suhajda') for sponsoring their CI/CD VMs, thus making the app releases more streamlined and much easier now. 🎊🎊 Do check out their [products](https://codemagic.io/integrations 'Codemagic - integrations') section for more.

- Special shoutout to [@CodyJung](https://github.com/CodyJung 'CodyJung') for adding the [Fujifilm](https://github.com/ganeshrvel/go-mtpfs/pull/2) and [Garmin](https://github.com/ganeshrvel/go-mtpfs/pull/1) device support. 🔥🔥

- Thanks to Ms [Ayushi Bothra](https://www.linkedin.com/in/ayushi-bothra-3103/ 'Ayushi Bothra') for contributing to the documentation and pages.

- App logo was contributed by [Shubhendu Mitra](https://www.linkedin.com/in/shubhendum/ 'Shubhendu Mitra - LinkedIn'). Make sure to check out more of his work on [Behance](https://www.behance.net/soponhara 'Shubhendu Mitra - Behance').

- Thanks to [Vladimir Menshakov](https://github.com/whoozle 'Vladimir Menshakov') for [android-file-transfer-linux](https://github.com/whoozle/android-file-transfer-linux 'android-file-transfer-linux') (the legacy MTP Kernel)

- Shoutout to [@yennsarah](https://github.com/yennsarah 'yennsarah'), [@h0tk3y](https://github.com/h0tk3y), [@riginoommen](https://github.com/riginoommen 'riginoommen'), [@AjithKumarvm](https://github.com/AjithKumarvm 'AjithKumarvm'), [@kiranshaji555](https://github.com/kiranshaji555), Dick Cowan, Kjell Dankert, Thorolf E.R. Weißhuhn and to all other community members who helped me test the application.

- This app was built upon [https://github.com/ganeshrvel/electron-react-redux-advanced-boilerplate](https://github.com/ganeshrvel/electron-react-redux-advanced-boilerplate 'https://github.com/ganeshrvel/electron-react-redux-advanced-boilerplate'), which is a heavily modified fork of [https://github.com/electron-react-boilerplate/electron-react-boilerplate](https://github.com/electron-react-boilerplate/electron-react-boilerplate 'https://github.com/electron-react-boilerplate/electron-react-boilerplate').

- The icons used in the app were made by [flaticon](https://www.flaticon.com), [good-ware](https://www.flaticon.com/authors/good-ware) and [kiranshastry](https://www.flaticon.com/authors/kiranshastry) which are licensed under [CC 3.0 BY](https://creativecommons.org/licenses/by/3.0/ 'Creative Commons BY 3.0').

- The "no image found" icon was made by [Phonlaphat Thongsriphong](https://www.iconfinder.com/phatpc 'Phonlaphat Thongsriphong').

## Native and other dependency licenses

| Component                              | Evidence and status                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenMTP application code               | Root MIT license; original notices preserved. This does not relicense third-party components.                                                                                                                                                     |
| Legacy Android File Transfer for Linux | Vladimir Menshakov, copyright 2015–2018 in the pinned sources. Sources state LGPL 2.1 or later. The reviewed source patch and verbatim LGPL 2.1 text are in [native/](native/); see [native compatibility](NATIVE_MTP.md).                        |
| Kalam and Go dependencies              | Source module pins `go-mtpfs`, `go-mtpx`, JSON and concurrency dependencies in `ffi/kalam/native/go.mod`; bundled binaries also require provenance/license review before redistribution. A full binary license manifest has not been established. |
| libusb bundled dylibs                  | Third-party native artifacts; complete version/build/source/license correspondence remains to be recorded. The application's MIT license is not a substitute.                                                                                     |
| pretty-file-icons                      | Retain its [own MIT license](../app/vendors/pretty-file-icons/LICENSE), including its existing copyright text.                                                                                                                                    |
| Icon artwork and logo                  | Original credits above retained. CC BY 3.0 artwork attribution remains applicable. A per-asset attribution audit is still needed before a packaged release.                                                                                       |
| npm/Electron dependencies              | Resolved through `yarn.lock`; respective dependency licenses remain applicable. This page is not a complete generated notice inventory.                                                                                                           |

## Redistribution review still required

The pinned Legacy source and patch are not relicensed under MIT. Read the [included LGPL text](native/LICENSE.LGPL-2.1), especially sections 1, 2, 4 and 6, before redistributing a native executable. Modified-source notices, complete corresponding source and the appropriate linking/relinking provisions must be assessed for the actual artifact and distribution method. An upstream URL plus a binary checksum alone does not establish that every obligation is met.

No corrected executable is added by this documentation task. However, the existing Git repository already tracks native executables and dylibs, so publishing the repository can itself redistribute binaries. Original binary build inputs, complete notices and source correspondence remain unresolved publication-review items. See the [publication plan](PUBLICATION_PLAN.md); this is an engineering inventory, not a completed legal-compliance certification.

## T13 provenance update

The [native provenance review](NATIVE_PROVENANCE.md) distinguishes identified LGPL/BSD terms from incomplete corresponding-source and permission evidence. In particular, inspected `go-mtpx` files did not establish its license, and bundled Go artifacts record different module generations. No binary is cleared for redistribution merely because it was inherited. New local commits contain no native binary changes; publishing the full history remains a separate blocked decision.
