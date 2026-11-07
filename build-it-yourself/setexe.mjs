// Puts the app icon and name into the .exe (pure JS, no Windows tools needed).
import fs from 'fs';
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
const [exePath, icoPath, version, title = 'App', exeName = 'App'] = process.argv.slice(2);
const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1, lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map(i => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const [a, b, c] = version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: title, ProductName: title, CompanyName: process.env.COMPANY || 'Root Cellar', OriginalFilename: exeName + '.exe', InternalName: exeName, LegalCopyright: '', FileVersion: version, ProductVersion: version });
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('exe resources updated');
