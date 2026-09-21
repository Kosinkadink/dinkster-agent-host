# Official nested subgraph fixtures

Source: Comfy-Org/workflow_templates, revision
`db9d5859d09c21a2d4101a1c18f64fc2f70e4fa4`, `templates/`.
The JSON is unchanged semantically; formatting and Unicode escapes are normalized.
Each workflow contains an instance inside another definition.

Original source SHA-256:

| File | SHA-256 |
| --- | --- |
| image_netayume_lumina_t2i.json | c9ed8360e179a3d68e110ced68b8b1db74e6f8a4261652b8eeda30c753bab676 |
| image_flux2_klein_image_edit_4b_distilled.json | e0388a8870495802314d58fa61616ddcdb7064dac5f85a8787c9e08180b8a560 |
| video_wan_vace_flf2v.json | a3e93893792803f7118a444dab365badab954d8304a7956bd6a79226dfa11a4f |

Browser tests use the captured `object_info.json` source schemas, not invented
backend aliases. Import and save/reopen are tested; model inference is not.
