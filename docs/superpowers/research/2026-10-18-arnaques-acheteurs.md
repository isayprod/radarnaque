# Arnaques aux acheteurs sur 2ememain / 2dehands et Facebook Marketplace (Belgique) : recherche pour le prompt de Radarnaque

Date de la recherche : 18 octobre 2026. Toutes les affirmations portent une URL.

Niveaux de fiabilité :
- **[officiel]** : autorité, banque, police, plateforme ou presse de référence.
- **[presse]** : média.
- **[faible]** : blog commercial, avis isolé, forum, ou chiffre non vérifiable.
- **[synthèse]** : mon inférence à partir de plusieurs sources. Elle n'est pas sourcée telle quelle.

**Limite importante.** Reddit (r/belgium, r/brussels, r/Belgium2, r/vlaanderen, r/thenetherlands, r/france) est **bloqué pour mes outils** : `reddit.com` est inaccessible à la recherche comme à la lecture. Aucune affirmation de ce document ne vient donc de Reddit. Les pages d'aide de 2dehands et 2ememain (`help.2dehands.be`) sont des applications JavaScript que je n'ai pas pu lire. Les pages `politie.be` / `police.be` renvoient une erreur 403 à la lecture ; je les cite à partir des extraits de recherche, et je le signale à chaque fois.

---

## 1. Contexte belge : arnaques les plus signalées contre les acheteurs

### 1.1 Volumes et ordres de grandeur
- **SPF Économie / FOD Economie.** 11 821 signalements de fraude via ConsumerConnect en 2024 (14 M€ de préjudice, 2 433 € en moyenne par victime). En 2025, près de 11 000 signalements, 6 805 victimes et 32 M€ (4 686 € en moyenne). Seulement ~1 % des victimes de faux webshops portent plainte. [officiel] https://news.economie.fgov.be/263263-100-000-meldingen-over-fraude-in-afgelopen-5-jaar/
- **Places de marché, 2023.** L'Inspection économique a reçu 1 912 signalements de personnes escroquées sur des places de marché en ligne en 2023, pour ~530 718 € de préjudice, « pour toutes sortes de produits, pas seulement des voitures ». [presse, chiffres SPF] https://www.vrt.be/vrtnws/nl/2024/04/03/valse-advertenties-auto-s/
- **Côté vendeurs (faux acheteurs).** 377 signalements en 2023 contre 868 en 2021, mais le préjudice moyen passe de 1 225 € à 1 800 € (+47 %). [officiel] https://news.economie.fgov.be/233676-tweedehandsverkoop-pas-op-voor-nepkopers/
- **Taux de base sur 2ememain.** En 2019, le porte-parole de 2ememain estimait que « moins de 1 % » des 60 000 à 70 000 nouvelles annonces quotidiennes étaient touchées. Un journaliste a observé environ un contact d'escroc pour cinq annonces publiées (côté vendeur). [presse, ancien] https://www.lavenir.net/actu/belgique/2019/08/27/2ememain-prepare-une-riposte-ZWZK4AM2RJF23N4ADCSFYYJBHI/
  → **La grande majorité des annonces est légitime.** C'est l'argument central pour calibrer le modèle.

### 1.2 Schémas contre l'acheteur (le faux vendeur)
1. **Prix très attractif, paiement d'avance, puis disparition.** C'est la description officielle de ConsumerConnect : « zeer aantrekkelijke prijs », paiement immédiat ou par transfert d'argent (Western Union), puis « alle contactgegevens verdwijnen ». [officiel] https://consumerconnect.be/nl/themas/consumentenbedrog/verdacht/online/2dehands
2. **Voiture d'occasion « à l'étranger ».** Annonce sur 2dehands avec des photos volées sur AutoScout24 et un prix cassé : un Hyundai Kona à 7 000 € pour 20 500 € sur l'annonce réelle, soit ~34 % du prix. Le vendeur dit habiter en Espagne, propose une livraison par un transporteur (une fausse société imitant Geis Group) et demande « de helft van het bedrag » sur un compte espagnol. [presse] https://www.vrt.be/vrtnws/nl/2024/04/03/valse-advertenties-auto-s/
   - Une plainte de janvier 2025 décrit le même schéma sur Facebook Marketplace : paiement pour voir le véhicule, ou paiement au transporteur parce que le « vrai vendeur » est à l'étranger. Facebook a jugé l'annonce non suspecte. [faible, plainte individuelle] https://www.test-aankoop.be/klagen/publieke-klachten/klachten-marketplace/eb3624acc15ec3b637
3. **Lien de paiement hameçon envoyé par le « vendeur ».** Une acheteuse d'une Nintendo Switch sur 2ememain reçoit un lien « pour finaliser l'achat ». Il mène à une fausse plateforme de paiement où elle saisit ses données bancaires ; 3 400 € sont débités. [presse, 2020, d'après HLN] https://www.bladi.net/belgique-escroquerie-site-internet,64449.html
   - En 2023, sept suspects ont été arrêtés à Anvers et Lier : ils se faisaient passer pour acheteurs **et** vendeurs sur 2dehands et Facebook Marketplace et utilisaient des liens d'hameçonnage. [presse] https://www.vrt.be/vrtnws/nl/2023/02/10/zeven-verdachten-van-phishing-via-tweedehandswebsites-opgepakt/
4. **Location et kots.** Selon perspective.brussels (février 2025), les étudiants bruxellois « sont confrontés à 30 % d'arnaques » pendant leur recherche, et « un étudiant sur trois a été victime d'une arnaque ». [presse] https://www.rtbf.be/article/crise-du-logement-etudiant-a-bruxelles-6-etudiants-sur-10-ont-eprouve-des-difficultes-a-trouver-un-kot-11505305
   - Cas type : un faux propriétaire demande vite 900 € (loyer et caution) avant toute visite. [presse] https://www.rtbf.be/article/attention-aux-arnaques-a-la-location-sur-le-net-9623353
5. **Tickets de festival.** La police du Limbourg a signalé de faux tickets Pukkelpop vendus dans un groupe Facebook et sur un faux site imitant TicketSwap. [presse] https://www.brusselstimes.com/2281851/police-warn-of-counterfeit-pukkelpop-tickets
   - Pour Rock Werchter 2022, de nombreuses victimes ont payé le même profil Facebook. [presse] https://www.vrt.be/vrtnws/nl/2022/06/29/massale-ticketfraude-op-rock-werchter/
   - Pukkelpop n'autorise que sa bourse officielle (pas TicketSwap). [presse] https://www.vrt.be/vrtnws/nl/2024/06/24/valse-festivaltickets-zo-trap-je-nooit-in-de-val/
6. **Biens volés (vélos électriques).** Une enquête RTBF décrit sur Marketplace et 2ememain « toute une économie parallèle ». Exemple : un vélo électrique de 4 300 € proposé au dixième de sa valeur. [presse] https://www.rtbf.be/article/investigation-vol-de-velos-un-fleau-hors-de-controle-10998532
   - Test-Achats signale aussi les biens volés : un acheteur de bonne foi peut devoir les rendre. [officiel] https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main
7. **Contrefaçons et produits non conformes.** Test-Achats les cite, ainsi que le reconditionné « au rabais de plus de 60 % ». [officiel] https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main

### 1.3 Conseils officiels belges (utiles pour le texte d'avis)
- Ne pas quitter la plateforme. Méfiance face à un vendeur pressé ou à une offre « te mooi om waar te zijn ». Payer par virement instantané, PayPal ou le paiement intégré à la plateforme. [presse] https://www.vrt.be/vrtnws/nl/2024/07/03/veilig-kopen-verkopen-tweedehands/
- **Test-Achats (janvier 2026)** :
  - acheter localement et payer en main propre ;
  - préférer la carte de crédit ou PayPal à Bancontact ;
  - ne jamais scanner un QR code « pour recevoir de l'argent » ;
  - un petit paiement « de vérification » est « toujours un début d'arnaque » ;
  - éviter Western Union et MoneyGram.
  Source : [officiel] https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main
- **Bancontact (octobre 2024)** : 2dehands et Vinted proposent le paiement Bancontact/Payconiq dans l'application. Sur Marketplace, le paiement se fait surtout par virement ou QR code, et c'est là que se concentre le risque d'hameçonnage. [officiel] https://www.bancontact.com/en/news/how-can-you-recognise-phishing-on-second-hand-platforms
- **Payconiq** : un vrai lien de demande de paiement commence par `payconiq.com/payme`. C'est le bénéficiaire qui crée la demande, jamais le payeur. [officiel, d'après un extrait de recherche] https://payconiq.be/en/news/don-t-let-cybercrime-get-you-this-is-how-you-can-detect-phishing-and-fraudulent-content-in-mobile-payments
- **Police locale** : « 2dehands.be zal je nooit vragen voor een IBAN-verificatie » ; garder la conversation dans le chat. [officiel, page en 403, cité d'après l'extrait de recherche] https://www.politie.be/5911/nieuws/oplichting-en-fraude-op-2dehands-herkennen

---

## 2. Pays-Bas et France : schémas transposables à nos acheteurs

### 2.1 Marktplaats (même groupe et même technologie que 2dehands/2ememain)
- **Fraudehelpdesk, « misleidende verkoop » via les plateformes de vente.** 731 signalements et 586 victimes sur les 7 premiers mois de 2025, contre 618 et 389 en 2024. Préjudice : ~350 k€. Au total, plus de 100 000 signalements en 2025 (+60 %). [officiel, d'après un extrait de recherche ; je n'ai pas pu lire le PDF] https://www.fraudehelpdesk.nl/wp-content/uploads/2025/08/persbericht-halfjaarcijfers-04082025-final.pdf et https://www.fraudehelpdesk.nl/wp-content/uploads/2026/02/Persbericht-jaarcijfers-2025-final.pdf
- **Marktplaats, signaux officiels.**
  - Marktplaats ne demande jamais l'adresse e-mail ni le téléphone dans le chat.
  - Les faux sites de paiement imitent Marktplaats, iDEAL et Tikkie.
  - Méfiance envers un profil récent, avec peu d'avis, ou sans les badges « Bankrekening gecontroleerd », « ID gecontroleerd », « Betalen met iDeal ».
  - Le seul flux officiel est « Betalen en Verzenden » (« Doe een voorstel » → demande de paiement dans Berichten).
  Source : [officiel] https://www.marktplaats.nl/m/betaalfraude/
- **Faux comptes professionnels (AVROTROS Radar, décembre 2022).** Des escrocs ont ouvert des comptes **Marktplaats Pro** avec un numéro KvK bidon et ont acheté des **topadvertenties** pour de faux camping-cars. Signes : prix attractif, **messagerie désactivée**, contact uniquement par **e-mail écrit dans l'annonce**, propriétaire « parti en Angleterre », « intermédiaire » qui garde l'argent. [presse] https://radar.avrotros.nl/artikel/zet-marktplaats-poort-open-voor-fraudeurs-53867
  → **Un statut pro ou une mise en avant payante ne prouve pas la légitimité.**
- **Location.** Des escrocs copient les photos de vrais bailleurs et réclament un mois de loyer et la caution via Facebook ou TikTok. [presse] https://nos.nl/l/2624811
  - Script classique : « le propriétaire est à l'étranger », pas de visite possible, clés envoyées par coursier après paiement. [faible, guide] https://inburgering.org/nl/guides/rental-scams-netherlands
- **Bien de valeur à bas prix, vendeur et objet à l'étranger** (souvent en Angleterre) : cas récurrents pour voitures et caravanes. [presse, 2012, ancien] https://www.bnnvara.nl/kassa/tips-oplichting-met-buitenlandse-aanbieding-op-marktplaats

### 2.2 Leboncoin et Vinted
- **Leboncoin.** Le faux « paiement sécurisé » est le scénario le plus cité : un faux mail ou une fausse page aux couleurs de Leboncoin. [faible, blogs] https://www.fiches-auto.fr/articles-auto/arnaques/s-3221-arnaque-au-paiement-securise-leboncoin.php ; https://www.welivesecurity.com/fr/fraude/6-principales-escroqueries-a-eviter-sur-leboncoin-et-autres-plateformes-de-vente-entre-particuliers/
- **Voiture.** Vendeur qui brade « avant un départ urgent à l'étranger » ; paiement par mandat cash ou Western Union. [faible] https://www.capcar.fr/blog/comment-reconnaitre-une-arnaque-de-voiture-a-vendre-sur-leboncoin
- **Rendez-vous physique.** Une annonce de PS5 à 700 € sur leboncoin servait de piège : le faux vendeur s'est enfui avec l'argent de l'acheteur pendant le rendez-vous. [presse] https://www.24matins.fr/aisne-quatre-mineurs-interpelles-pour-une-arnaque-a-la-playstation-5-1249794
- **Vinted et contrefaçon (60 Millions, juin 2024).** Des Nike Travis Scott à 450 € se sont révélées être des copies grossières, alors que le vendeur était **bien noté**. [presse] https://www.presse-citron.net/attention-aux-arnaques-sur-vinted-previent-60-millions-de-consommateurs/
  → **De bons avis n'excluent pas la contrefaçon** pour les produits de luxe.
- **Annonces « photo seulement » ou « boîte vide ».** Sur eBay, des annonces de PS5 portaient « Only Pictures » en fin de titre. [presse, 2020] https://www.journaldugeek.com/2020/11/30/ps5-attention-achetez-console-ebay-recevoir-photo/
  - Au Japon, des Switch 2 vendues en « boîte vide ». [faible] https://www.toy-people.com/en/?p=100723

### 2.3 Royaume-Uni (meilleures statistiques par catégorie, transposables avec prudence)
- **TSB (janvier 2024)** :
  - 73 % des fraudes à l'achat de ses clients viennent de Facebook Marketplace ;
  - sur 100 annonces Marketplace testées, 34 % ont été jugées frauduleuses. L'échantillon n'est pas aléatoire et vient du fil de l'équipe ;
  - exemples : iPhone 13 « brand new » à 84 £ au lieu de 599 £, soit 14 % du prix ; friteuse Ninja neuve à 65 £ au lieu de 249 £ ;
  - tactiques : refus de visite, avance de frais, renvoi vers un faux site.
  Source : [officiel, banque] https://www.tsb.co.uk/news-releases/urgent-consumer-warning-as-tsb-finds-over-a-third-of-adverts-on-facebook-marketplace-could-be-scams
- **Lloyds.** 68 % des arnaques à l'achat commencent sur Facebook ou Instagram ; perte moyenne d'environ 570 £. Les objets le plus souvent annoncés faussement sont les vêtements, les baskets, les consoles et les téléphones. [officiel, 2023] https://www.lloydsbankinggroup.com/assets/pdfs/media/press-releases/2023-press-releases/lloyds-banking-group/300523-two-thirds-of-online-shopping-scams-now-start-on-facebook-and-instagram.pdf
  - En 2025, les véhicules et les tickets dominent ; les signalements pour consoles baissent de 35 %. [presse] https://www.crowdfundinsider.com/2025/12/256857-major-uk-purchase-scams-examined-in-year-end-lloyds-bank-report/
- **UK Finance (2025).** Les arnaques à l'achat représentent 71 % des cas d'APP fraud, pour 118,1 M£. Leur perte moyenne est donc faible (~670 £ d'après mon calcul) : arnaques **fréquentes mais de montant modéré**. [presse] https://www.crowdfundinsider.com/2026/06/285657-fraudulent-activities-and-sophisticated-scams-continue-to-pose-serious-threat-to-uk-security-as-losses-approach-1-3b/
- **Which?** Facebook Marketplace n'offre aucune protection acheteur, et 25 % des acheteurs croient à tort qu'elle existe. Des annonces piégées de test sont restées en ligne au moins une demi-journée. [presse] https://www.which.co.uk/policy-and-insight/article/scam-ads-slipping-through-the-net-too-easily-on-second-hand-marketplaces-which-warns-aqyF66m1TlU1
- **Comptes Facebook piratés.** Des comptes anciens et des « amis » publient soudain des annonces (tickets, objets). Un compte ancien n'est donc pas une garantie. [presse] https://ctvnews.ca/barrie/article/facebook-marketplace-scams-on-the-rise-as-police-issue-warning-to-users ; https://globalnews.ca/news/11193801/okanagan-musician-falls-victim-to-facebook-marketplace-scam

---

## 3. Risque par catégorie

**Statistiques disponibles (Royaume-Uni, TSB 2023, part des fraudes à l'achat par volume).** Source : [officiel] https://www.tsb.co.uk/news-releases/urgent-consumer-warning-as-tsb-finds-over-a-third-of-adverts-on-facebook-marketplace-could-be-scams

| Rang | Catégorie | Part |
|---|---|---|
| 1 | Véhicules et pièces | 21 % |
| 2 | Téléphones | 7 % |
| 3 | Chaussures et vêtements | 7 % |
| 4 | Consoles et accessoires | 7 % |
| 5 | Tickets de concert ou de festival | 6 % |
| 6 | Petite électronique | 5 % |
| 7 | Meubles | 5 % |
| 8 | Électroménager | 4 % |
| 9 | Services | 3 % |
| 10 | Matériaux et outils | 3 % |

Ces chiffres sont des **parts du volume de fraude**, pas des **taux de fraude par annonce**. Les meubles ou les vêtements sont nombreux en volume parce qu'ils sont très présents, pas parce qu'une annonce y est plus risquée. [synthèse]

Je n'ai trouvé **aucune statistique belge par catégorie**. Le consensus qualitatif belge cite :
- voitures [VRT 2024] ;
- kots et locations [RTBF 2025] ;
- tickets de festival [Brussels Times, VRT] ;
- vélos électriques volés [RTBF] ;
- consoles et téléphones [HLN/Bladi 2020].

**Pourquoi les petits objets (< ~20 €) sont rarement des arnaques.**
- Le préjudice moyen observé est élevé : 1 800 € côté vendeur en 2023 (SPF), 2 433 € à 4 686 € par victime de fraude en 2024-2025 (SPF), ~570 £ pour une arnaque à l'achat (Lloyds). Les escrocs ciblent donc des montants qui justifient l'effort.
- Pour un petit objet, l'acheteur peut presque toujours retirer en main propre et payer à la remise. Le risque restant est la non-conformité, pas l'escroquerie.
- Exception : la **contrefaçon** de vêtements de marque (Vinted) et les annonces « appâts » à prix minuscule qui servent à faire sortir l'acheteur de la plateforme ou à lui envoyer un lien de paiement.
Ces trois points sont une [synthèse] des sources du §1.1 et du §2.3.

**Seuils de prix « trop beau pour être vrai ».** Aucun seuil officiel n'existe. Repères observés :
- Test-Achats : se méfier d'un reconditionné à « plus de 60 % » sous le prix public d'origine. [officiel] https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main
- Cas réels d'arnaque : voiture à ~34 % du prix de marché [VRT 2024] ; iPhone « neuf » à 14 % du prix public [TSB] ; vélo électrique à ~10 % [RTBF] ; friteuse neuve à 26 % [TSB].
- Un téléphone d'occasion en bon état se vend en général 70 à 90 % du prix neuf. [faible, blog commercial] https://blog.ecoatm.com/how-to-avoid-fake-iphones-on-facebook-marketplace/
- **Seuils proposés [synthèse]** : pour un objet de forte valeur (> ~150 €), on compare au **prix d'occasion typique** de l'objet dans l'état annoncé.
  - Moins de ~50 % de ce prix : signal fort.
  - Entre 50 et 70 % : signal modéré.
  - Un objet « neuf, scellé » sous ~60 % du prix neuf : signal fort.
  - Pour un objet usé, ancien, à réparer, ou vendu « pour pièces », un prix bas est **normal**.

---

## 4. Signaux d'alerte visibles dans l'annonce elle-même

Chaque signal est classé selon sa force. Une ligne marquée ⚠ peut aussi être légitime ; voir le §6.

**Signaux forts**
- **Paiement hors plateforme ou d'avance mentionné dans le texte** : Western Union, MoneyGram, « paiement à l'avance », « vooraf betalen », « acompte avant visite », « voorschot ».
  - Sources : [officiel] https://consumerconnect.be/nl/themas/consumentenbedrog/verdacht/online/2dehands ; https://www.beobank.be/nl/blog/fraude/phishing-op-tweedehandssites-wat-het-en-hoe-vermijd-je-het.html
- **Vendeur ou objet à l'étranger, avec livraison par « transporteur » ou « intermédiaire ».** Formulations relevées : « ik woon in het buitenland », « de auto laten leveren via een transportbedrijf », « départ à l'étranger ».
  - Sources : [presse] https://www.vrt.be/vrtnws/nl/2024/04/03/valse-advertenties-auto-s/ ; [officiel plateforme] https://www.autoscout24.be/nl/informeren/advies/veiligheid/frauduleuze-advertenties-en-phishing/ ; [presse] https://radar.avrotros.nl/artikel/zet-marktplaats-poort-open-voor-fraudeurs-53867
- **Contact imposé hors plateforme** : « WhatsApp uniquement », « contactez-moi par mail », e-mail ou numéro écrit dans la description, messagerie désactivée.
  - Sources : [officiel] https://www.marktplaats.nl/m/betaalfraude/ ; [presse] https://radar.avrotros.nl/artikel/zet-marktplaats-poort-open-voor-fraudeurs-53867
  - Note : dans nos entrées, téléphones et e-mails sont masqués, mais **la présence d'un masque** est elle-même un fait utile (voir §8).
- **Refus de visite ou de remise en main propre pour un objet cher ou encombrant** (voiture, logement, meuble) : « envoi uniquement », « alleen verzenden », « pas de visite possible ».
  - AutoScout24 parle de « een grote rode vlag » pour le refus de visite : [officiel] https://www.autoscout24.be/nl/informeren/advies/veiligheid/frauduleuze-advertenties-en-phishing/
  - TSB : [officiel] https://www.tsb.co.uk/news-releases/urgent-consumer-warning-as-tsb-finds-over-a-third-of-adverts-on-facebook-marketplace-could-be-scams
- **« Neuf » ou « scellé » très en dessous du prix public**, pour un téléphone, une console ou un appareil. [officiel] TSB (ci-dessus)
- **Location : caution ou loyer demandé avant visite, caution en espèces ou sur un compte étranger.** En Belgique, la garantie va sur un compte bloqué au nom du locataire et ne dépasse pas 2 mois de loyer.
  - [officiel] https://www.test-aankoop.be/woning-energie/huren/dossier/studentenkamers ; [presse] https://www.rtbf.be/article/attention-aux-arnaques-a-la-location-sur-le-net-9623353
- **Chiens et chats** : annonce sans numéro d'agrément (HK) ni numéro de puce sur un site généraliste. C'est **illégal** en Flandre, et les particuliers ne peuvent pas vendre de chiens ou de chats via Facebook. En Wallonie aussi, le numéro d'agrément doit figurer dans l'annonce.
  - [officiel] https://www.vlaanderen.be/huisdierinfo/adopteren-en-verkoop/aankoop-of-adoptie-van-een-huisdier ; https://wallonie.be/fr/demarches/obtenir-un-agrement-en-tant-queleveur-de-chiens-ou-de-chats
  - « Chiots bon marché, seulement les frais de transport à payer » : [faible, forum] https://radar-forum.avrotros.nl/viewtopic.php?p=814146

**Signaux modérés**
- **Urgence** : « dringend », « snel weg », « vite », « départ imminent », « eerst betaald eerst gediend ». Les sources signalent un vendeur « visiblement pressé » ; c'est un signal plus fort dans le chat que dans l'annonce.
  - [presse] https://www.vrt.be/vrtnws/nl/2024/07/03/veilig-kopen-verkopen-tweedehands/ ; [officiel] https://www.autoscout24.be/nl/informeren/advies/veiligheid/frauduleuze-advertenties-en-phishing/
- **Texte traduit automatiquement ou plein de fautes, détails vagues, photos qui ne correspondent pas ou visiblement reprises ailleurs.** [officiel] https://www.autoscout24.be/nl/informeren/advies/veiligheid/frauduleuze-advertenties-en-phishing/
  - Les photos copiées sont pour le Fraudehelpdesk le signal le plus clair en location. [faible, guide qui cite le Fraudehelpdesk] https://inburgering.org/nl/guides/rental-scams-netherlands
- **Compte très récent qui vend un objet cher, sans avis.** [officiel] https://www.marktplaats.nl/m/betaalfraude/
  - ⚠ Sans autre signal, c'est faible : beaucoup de vendeurs légitimes débutent.
- **Compte ancien qui publie soudain beaucoup d'objets chers sans rapport entre eux** (piratage, surtout sur Facebook). [presse] https://ctvnews.ca/barrie/article/facebook-marketplace-scams-on-the-rise-as-police-issue-warning-to-users
- **Tickets d'événements complets vendus par un particulier, surtout sur Facebook.** Les organisateurs n'autorisent que leur bourse officielle (Pukkelpop) ou Ticketmaster (Rock Werchter).
  - [presse] https://www.vrt.be/vrtnws/nl/2024/06/24/valse-festivaltickets-zo-trap-je-nooit-in-de-val/ ; https://www.vrt.be/vrtnws/nl/2022/06/29/massale-ticketfraude-op-rock-werchter/
- **Vélo électrique ou de course à une fraction de sa valeur, sans facture ni numéro de cadre** (bien volé). [presse] https://www.rtbf.be/article/investigation-vol-de-velos-un-fleau-hors-de-controle-10998532
- **Luxe ou baskets « authentiques » à prix bas** (contrefaçon). [presse] https://www.presse-citron.net/attention-aux-arnaques-sur-vinted-previent-60-millions-de-consommateurs/
- **Titre ou description du type « photo seulement », « boîte seule », « alleen doos »** pour un objet cher. Ce n'est pas une arnaque en soi, mais l'acheteur doit lire attentivement. [presse] https://www.journaldugeek.com/2020/11/30/ps5-attention-achetez-console-ebay-recevoir-photo/

**Signaux faibles ou anecdotiques** (non vérifiés, à ne pas pondérer fortement)
- Prix aux terminaisons bizarres : aucune source sérieuse trouvée.
- « Militaire en mission » ou « offshore » : script connu dans les arnaques sentimentales et à la location internationale, mais **aucune source belge 2023-2026 trouvée** pour les petites annonces.

---

## 5. Arnaques invisibles dans l'annonce (elles se jouent dans la conversation)

Le score ne peut pas les détecter. Le texte d'avis doit pourtant y préparer l'acheteur.
- **Faux lien de paiement ou de « réservation » envoyé par le vendeur.** Il imite 2ememain/2dehands, Bancontact, Payconiq, bpost, DHL ou Mondial Relay, et mène à une page qui vole les données bancaires.
  - [presse] https://www.bladi.net/belgique-escroquerie-site-internet,64449.html ; [officiel] https://www.bancontact.com/en/news/how-can-you-recognise-phishing-on-second-hand-platforms
- **Faux paiement « de vérification » (0,01 € ou 0 €) ou « vérification IBAN ».** La police indique que 2dehands ne le demande jamais. [officiel] https://www.beobank.be/nl/blog/fraude/phishing-op-tweedehandssites-wat-het-en-hoe-vermijd-je-het.html ; https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main
- **QR code « pour recevoir de l'argent ».** On ne scanne jamais un QR code pour **recevoir**. [officiel] https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main
- **Faux transporteur ou faux tiers de confiance** (« escrow », « intermédiaire qui garde l'argent »). [officiel] https://www.autoscout24.be/nl/informeren/advies/veiligheid/frauduleuze-advertenties-en-phishing/ ; [presse] https://radar.avrotros.nl/artikel/zet-marktplaats-poort-open-voor-fraudeurs-53867
- **Faux service client de la plateforme**, ou capture d'écran truquée demandant l'e-mail ou le téléphone. [officiel] https://www.marktplaats.nl/m/betaalfraude/
- **Demande de passer sur WhatsApp ou Telegram en cours de conversation.** [officiel] https://www.beobank.be/nl/blog/fraude/phishing-op-tweedehandssites-wat-het-en-hoe-vermijd-je-het.html
- **Demande d'acompte pour « réserver »**, puis frais supplémentaires (douane, transport, assurance) : « encore un dernier paiement ». [presse] https://radar.avrotros.nl/artikel/zet-marktplaats-poort-open-voor-fraudeurs-53867
- **Arnaque au rendez-vous** : vol ou fausse remise lors d'une rencontre physique. [presse] https://www.24matins.fr/aisne-quatre-mineurs-interpelles-pour-une-arnaque-a-la-playstation-5-1249794
- **Surpaiement ou faux reçu de virement.** Ce schéma vise surtout les vendeurs, il est donc hors périmètre acheteur, mais le connaître aide. [officiel] https://news.economie.fgov.be/233676-tweedehandsverkoop-pas-op-voor-nepkopers/
- **Même le paiement intégré n'est pas infaillible** : une plainte rapporte des fonds libérés sans confirmation de l'acheteur. [faible, plainte individuelle] https://www.test-aankoop.be/klagen/publieke-klachten/fraude-2dehands-via-betaalplat/0103004c42beae8550

---

## 6. Schémas légitimes à NE PAS signaler (faux positifs)

### 6.1 Professionnels et commerces qui utilisent l'annonce comme publicité
- **Admarkt** est le produit publicitaire au clic de Marktplaats et 2dehands pour les professionnels. Ses annonces apparaissent en haut des pages de catégorie, et ces professionnels publient souvent via un flux produit automatique.
  - [faible, 2014] https://twinklemagazine.nl/2014/03/adverteren-op-marktplaats-admarkt-de-basis/ ; [faible, intégrateur] https://www.channable.com/channels/marktplaats-admarkt/
- **Lien vers le site du professionnel.** Les annonces professionnelles sur 2dehands/2ememain peuvent contenir un lien gratuit vers la boutique en ligne : c'est l'origine probable de « Bekijk website / Visiter le site ». [faible, intégrateur] https://www.koongo.com/integration/custom-platform/2dehands/
- **Marktplaats Pro** offre aussi des liens gratuits vers le site web. Un lien de site indique un professionnel ou une annonce payante, **mais ne le prouve pas**. [faible, d'après un extrait de recherche] https://www.channable.com/channels/marktplaats-admarkt/
- **Contre-exemple critique.** Des escrocs ont créé de faux comptes Pro et payé des mises en avant (Radar, 2022). Le statut pro baisse donc le risque, sans l'annuler, **quand** il s'accompagne de signaux forts : prix cassé, contact par e-mail seulement, objet à l'étranger. [presse] https://radar.avrotros.nl/artikel/zet-marktplaats-poort-open-voor-fraudeurs-53867
- **Marques d'un professionnel légitime [synthèse]** :
  - nom d'entreprise ;
  - beaucoup d'annonces **cohérentes** dans un même domaine (garage, agence, jardinerie, magasin de vélos) ;
  - lien de site ;
  - adresse physique ou showroom ;
  - prix de type « Prix sur demande / Prijs op aanvraag », « Zie omschrijving / Voir description » ou « Bieden / Faire une offre » ;
  - textes standardisés (garantie, TVA, financement, reprise).
- **Présentation recommandée [synthèse].** Afficher un **bandeau d'information**, pas un score alarmant : « Annonce d'un professionnel. Elle sert de vitrine : le prix et les conditions se négocient avec le commerce. » Rappeler les vérifications d'usage : numéro BCE/KBO, adresse, avis, garantie légale de 1 an minimum entre professionnel et consommateur pour un bien d'occasion. La durée de garantie relève de mes connaissances générales, pas d'une source consultée ici ; elle est à vérifier avant publication.
  - Le prix « sur demande » **n'est pas** un signal de risque. Il empêche seulement la comparaison au marché.

### 6.2 Autres schémas légitimes
- **« Bieden / Faire une offre »** est un type de prix normal sur 2dehands/2ememain, souvent pour des objets dont le vendeur ignore la valeur. [synthèse]
- **« Gratuit / À donner / Gratis »** : risque d'arnaque financière quasi nul pour l'acheteur, qui ne paie rien. Exceptions : animaux gratuits « contre frais de transport » (voir §4) et logements. [synthèse, sources du §4]
- **Compte ancien sans avis** : beaucoup d'utilisateurs ne reçoivent jamais d'avis. Un compte ancien et cohérent, avec des annonces dans des domaines similaires, est rassurant. Il faut seulement rester attentif à un compte ancien qui se met soudain à vendre beaucoup d'objets chers (piratage, §4). [synthèse]
- **Compte récent qui vend un ou deux objets courants à un prix normal** : c'est le cas typique d'un déménagement ou d'un tri. [synthèse]
- **Prix bas sur un objet usé, ancien, défectueux ou « pour pièces »**, ou sur un objet encombrant (meubles, électroménager à enlever soi-même) : c'est normal. [synthèse]
- **« Envoi possible »** n'est pas suspect. Seul **« uniquement par envoi » pour un objet cher et sans paiement intégré** l'est. Sur 2dehands/2ememain, l'envoi bpost avec paiement via la plateforme est un flux officiel. Les conditions générales de 2dehands (février 2026) renvoient vers ses demandes de paiement, la protection acheteur d'Online Payment Platform et l'envoi bpost. [officiel, d'après les liens du PDF, texte illisible] https://www.2dehands.be/i/assets/pdf/algemene_voorwaarden_2dehands.pdf
- **Description courte** : la plupart des particuliers écrivent peu. Ce n'est pas un signal. [synthèse]
- **Photos de catalogue** : normales pour un professionnel ou un article neuf dans sa boîte, mais suspectes pour une voiture ou un logement. [synthèse]

---

## 7. Conseils de prompt engineering

- **Expliquer le pourquoi des règles.** La documentation Anthropic indique qu'expliquer au modèle *pourquoi* un comportement importe améliore les réponses. Elle recommande aussi de calmer le langage agressif (« CRITICAL: You MUST… ») : avec les modèles récents, il **provoque du sur-déclenchement**. [officiel] https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
  → Pour nous, ne pas écrire « signale TOUT indice ». Expliquer plutôt que les fausses alertes font perdre la confiance de l'utilisateur et nuisent à des vendeurs honnêtes.
- **Exemples.** Donner 3 à 5 exemples **variés** (légitimes et frauduleux), balisés `<example>`, sinon le modèle copie des motifs non voulus. [officiel] (même URL)
- **Taux de base.** La grande majorité des annonces est légitime : moins de 1 % des annonces touchées selon 2ememain en 2019, chiffre ancien et déclaratif. [presse] https://www.lavenir.net/actu/belgique/2019/08/27/2ememain-prepare-une-riposte-ZWZK4AM2RJF23N4ADCSFYYJBHI/
  - Le 34 % de TSB vient d'un échantillon Facebook non aléatoire. [officiel] https://www.tsb.co.uk/news-releases/urgent-consumer-warning-as-tsb-finds-over-a-third-of-adverts-on-facebook-marketplace-could-be-scams
  - Il faut donc ancrer le score par défaut **bas** et ne le monter qu'avec des preuves. [synthèse]
- **Faux positifs des détecteurs LLM.** Un détecteur d'arnaques téléphoniques par LLM en temps réel garde un rappel élevé mais sa précision tombe à 0,70-0,77, contre 0,95-1,00 en analyse rétrospective. [preprint] https://arxiv.org/pdf/2502.03964
  - Un modèle généraliste a classé 351 messages légitimes comme arnaques, contre 4 pour un petit modèle affiné. [preprint, d'après un extrait de recherche] https://arxiv.org/pdf/2606.01475
  - Conclusion : les LLM ont tendance à sur-signaler, et la calibration est indispensable. [synthèse]
- **Estimer le prix du marché.** Les LLM peuvent estimer un prix d'occasion, mais les systèmes performants s'appuient sur des annonces similaires récupérées (RAG) et **rejettent les estimations peu sûres** grâce à un filtre de confiance (LLP, Xianyu, 2025). L'état (par exemple la batterie d'un iPhone) change fortement le prix. [preprint] https://arxiv.org/abs/2510.09347v1
  → Demander au modèle une **fourchette** de prix d'occasion et un **niveau de confiance**. N'utiliser l'écart de prix comme signal que si la confiance est moyenne ou haute et que l'objet est bien identifié (modèle, capacité, année, kilométrage). [synthèse]
- **Littérature anti-fraude.** Les caractéristiques classiques sont l'âge du compte, le nombre de ventes, le prix et les antécédents de fraude, et elles sont **combinées** : par exemple, compte de moins d'un an **et** moins de 5 ventes. [brevet] https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10546304
  - Pour les petites annonces, la copie d'annonces d'autres services est un marqueur. [académique] https://cdn.aaai.org/ocs/5928/5928-29821-1-PB.pdf
- **Donnée inconnue.** « Inconnu n'est jamais un signal de risque. » Une donnée absente (avis, âge du compte, état, nombre d'images) ne monte pas le score ; elle **baisse la confiance** et doit être dite comme telle. [synthèse]

---

## Tableau : Catégorie × fréquence d'arnaque × signaux spécifiques × seuil de prix suspect

« Fréquence » est relative et qualitative, sauf mention contraire. Les seuils sont une [synthèse] des cas cités au §3, à valider sur données réelles.

| Catégorie | Fréquence d'arnaque (acheteur) | Signaux spécifiques | Seuil de prix suspect |
|---|---|---|---|
| Voitures, motos, camping-cars | **Très élevée en montant** ; 21 % du volume chez TSB ; dominante chez Lloyds 2025 ; cas 2dehands chez VRT en 2024 | Vendeur ou objet à l'étranger, transporteur, acompte (« de helft »), refus de visite, photos reprises d'AutoScout24, e-mail dans le texte | < ~60 % de la cote d'occasion (cas réel à ~34 %) |
| Location, kots | **Très élevée** pour les étudiants (30 % d'arnaques rencontrées, Bruxelles 2025) | Caution ou loyer avant visite, propriétaire à l'étranger, clés envoyées, caution en espèces ou compte étranger, plus de 2 mois de caution | Loyer < ~70 % du marché local ; synthèse |
| Tickets de concert ou festival | **Élevée** ; 6 % chez TSB ; Lloyds 2025 ; Pukkelpop, Rock Werchter | Événement complet, vendeur particulier sur Facebook, refus de la bourse officielle, plusieurs billets, « e-ticket envoyé après paiement » | Pas de seuil : le prix est souvent au-dessus du nominal ; c'est le canal qui compte |
| Smartphones (iPhone) | **Élevée** ; 7 % chez TSB | « Neuf / scellé / sous garantie » à bas prix, envoi seulement, pas de facture | « Neuf » < 60 % du prix public ; occasion < 50 % de la cote d'occasion |
| Consoles (PS5, Switch 2) | **Élevée**, en baisse au Royaume-Uni (−35 % en 2025) ; 7 % chez TSB | Neuf à bas prix, « photo / boîte seule », envoi seulement | Mêmes seuils que les smartphones |
| Chiots et animaux | **Élevée** (qualitatif) ; illégal sans numéro HK | Pas de numéro d'agrément ni de puce, « seulement les frais de transport », animal importé, vente sur Facebook par un particulier (interdit en Flandre) | Prix de race très bas ou « gratuit + transport » |
| Vélos et vélos électriques | **Moyenne** en escroquerie, **élevée** en **biens volés** | Prix à une fraction de la valeur, pas de facture ni de numéro de cadre, plusieurs vélos haut de gamme | < ~30-40 % de la cote d'occasion |
| Ordinateurs, cartes graphiques, petite électronique | **Moyenne** ; 5 % chez TSB | Neuf à bas prix, reconditionné « plus de 60 % de remise », envoi seulement | « Neuf » < 60 % du prix public |
| Sacs de créateur, baskets | **Moyenne** (contrefaçon) ; 7 % pour vêtements et chaussures chez TSB | « 100 % authentique » sans preuve, prix bas pour un modèle rare ; de bons avis n'excluent rien | < ~50 % de la cote de revente |
| Électroménager, friteuses, « neuf en boîte » | **Moyenne** ; 4 % chez TSB | Objet neuf à prix cassé, plusieurs unités identiques | < ~40 % du prix public |
| Meubles, matériel bébé, jardin | **Faible par annonce** (5 % du volume chez TSB, mais la catégorie est énorme) | Rares : envoi seulement pour un meuble lourd, paiement d'avance | Prix bas = **normal** (objet encombrant, à enlever) |
| Accessoires, vêtements < ~20 € | **Très faible** | Seuls signaux : demande de quitter la plateforme, lien de paiement | Aucun seuil pertinent |
| Gratuit / à donner | **Quasi nulle** (pas de paiement) | Exceptions : animaux, logements, « frais de transport » | Sans objet |

Sources du tableau :
- TSB : https://www.tsb.co.uk/news-releases/urgent-consumer-warning-as-tsb-finds-over-a-third-of-adverts-on-facebook-marketplace-could-be-scams
- Lloyds : https://www.crowdfundinsider.com/2025/12/256857-major-uk-purchase-scams-examined-in-year-end-lloyds-bank-report/
- Voitures : https://www.vrt.be/vrtnws/nl/2024/04/03/valse-advertenties-auto-s/
- Kots : https://www.rtbf.be/article/crise-du-logement-etudiant-a-bruxelles-6-etudiants-sur-10-ont-eprouve-des-difficultes-a-trouver-un-kot-11505305
- Tickets : https://www.brusselstimes.com/2281851/police-warn-of-counterfeit-pukkelpop-tickets
- Animaux : https://www.vlaanderen.be/huisdierinfo/adopteren-en-verkoop/aankoop-of-adoptie-van-een-huisdier
- Vélos : https://www.rtbf.be/article/investigation-vol-de-velos-un-fleau-hors-de-controle-10998532
- Reconditionné et biens volés : https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main
- Contrefaçon : https://www.presse-citron.net/attention-aux-arnaques-sur-vinted-previent-60-millions-de-consommateurs/

---

## Liste de phrases-clés FR/NL pour les règles locales

Les phrases viennent des sources citées, sauf celles marquées *(proposée)*, qui sont des variantes plausibles à valider sur données réelles. Toutes s'appliquent au texte replié (minuscules, sans accents).

**Paiement hors plateforme ou d'avance** (complète `OFFSITE_PAYMENT_KEYWORDS`)
- FR :
  - « western union », « moneygram », « mandat cash »
  - « paiement à l'avance », « acompte », « acompte avant visite » *(proposée)*
  - « virement avant envoi » *(proposée)*
  - « coupon pcs », « carte cadeau », « crypto »
  - « paiement par transporteur » *(proposée)*
  - « escrow », « tiers de confiance » *(proposée)*
- NL :
  - « vooraf betalen », « voorschot », « aanbetaling »
  - « de helft van het bedrag » (VRT)
  - « betaling via transportbedrijf » *(proposée)*
  - « escrow », « tussenpersoon »
  - « cadeaukaart » *(proposée)*

**Vendeur ou objet à l'étranger, transporteur** (nouvelle règle proposée : `abroad_seller`)
- FR :
  - « je suis à l'étranger », « je vis à l'étranger », « départ à l'étranger »
  - « je suis actuellement en … » *(proposée)*
  - « livraison par transporteur », « le véhicule se trouve en espagne / en france / en allemagne » *(proposée)*
- NL :
  - « ik woon in het buitenland » (AutoScout24, VRT)
  - « verblijf momenteel in … » *(proposée)*
  - « leveren via een transportbedrijf » (VRT)
  - « de auto staat in spanje » *(proposée)*

**Contact hors plateforme** (nouvelle règle proposée : `offsite_contact`)
- FR : « whatsapp uniquement », « contactez-moi par mail », « uniquement par e-mail », « pas de messages ici » *(proposées)*
- NL : « alleen via whatsapp », « mail mij », « contact via e-mail », « reageer via mail » *(proposées)*
- Signal structurel plus fiable qu'un mot-clé : **présence d'un téléphone ou d'un e-mail masqué dans la description**.

**Envoi seulement** (déjà dans `SHIPPING_ONLY_KEYWORDS` ; ajouts)
- FR : « envoi uniquement », « pas de remise en main propre », « pas de visite » *(proposée)*, « uniquement par la poste » *(proposée)*
- NL : « alleen verzenden », « geen ophalen », « enkel verzending », « geen bezichtiging », « bezichtiging niet mogelijk » *(proposées)*

**Neuf ou scellé** (ne compte qu'avec un prix bas ; nouvelle règle proposée : `new_sealed_cheap`)
- FR : « neuf sous blister », « jamais ouvert », « scellé », « neuf dans sa boîte », « sous garantie »
- NL : « nieuw in doos », « geseald », « nooit geopend », « nog in folie », « met garantie »

**Photo ou boîte seulement** (règle d'avertissement, pas d'arnaque)
- FR : « photo uniquement », « boîte seule », « boîte vide »
- NL : « alleen doos », « lege doos », « enkel foto »
- EN : « only pictures » (journaldugeek)

**Urgence** (faible, ne compte qu'en combinaison)
- FR : « urgent », « à saisir vite », « départ imminent », « premier arrivé premier servi »
- NL : « dringend », « snel weg », « eerst betaald eerst gediend », « moet weg wegens verhuis » (fréquent aussi chez des vendeurs honnêtes)

**Location**
- FR : « caution avant visite », « clés envoyées », « propriétaire à l'étranger », « remise des clés par courrier »
- NL : « waarborg vooraf », « sleutels opsturen », « eigenaar in het buitenland », « geen bezichtiging mogelijk »

**Animaux**
- FR : « seulement les frais de transport », « chiot gratuit », « livraison du chiot »
- NL : « enkel transportkosten », « gratis pup », « pup wordt geleverd »
- Le signal **structurel** fort est l'**absence d'un numéro HK ou d'agrément et de puce**.

**Mots à exclure ou à neutraliser** (ils signalent un professionnel, pas une arnaque)
- FR : « prix sur demande », « tva déductible », « garantie 12 mois », « reprise possible », « financement », « showroom », « numéro d'entreprise »
- NL : « prijs op aanvraag », « btw aftrekbaar », « garantie », « inruil mogelijk », « financiering », « toonzaal », « ondernemingsnummer »

---

## Recommandations pour le prompt système

### A. Instructions concrètes à placer dans le prompt (formulées pour le modèle)

1. **Rôle et but.**
   « Tu aides un **acheteur** à repérer une annonce frauduleuse sur 2ememain/2dehands ou Facebook Marketplace en Belgique. La plupart des annonces sont honnêtes. Une fausse alerte fait perdre la confiance de l'utilisateur et nuit à des vendeurs honnêtes. Une alerte manquée peut coûter des centaines ou des milliers d'euros. Vise un score qui reflète la probabilité réelle. »

2. **Ancrage par défaut.**
   « Pars d'un score bas (environ 10-15) et monte-le seulement avec des éléments concrets tirés de l'annonce. Un seul signal faible (compte récent, pas d'avis, description courte, urgence) ne dépasse pas ~30. »

3. **Taux de base par catégorie.**
   « Tiens compte de la catégorie.
   - Risque de base élevé : voitures et véhicules, locations et kots, tickets d'événements, smartphones et consoles récents, chiots.
   - Risque moyen : ordinateurs et cartes graphiques, vélos électriques (risque d'objet volé), luxe et baskets (contrefaçon).
   - Risque faible : meubles, vêtements, matériel bébé, jardin, petits accessoires.
   Pour un objet de moins de ~30 €, ne dépasse pas ~25 sauf mention explicite d'un paiement hors plateforme ou d'un lien. »

4. **Prix contre marché.**
   « Si l'objet est identifiable (marque, modèle, capacité, année, kilométrage), estime une **fourchette de prix d'occasion en Belgique** dans l'état annoncé, avec une confiance (faible / moyenne / haute). Utilise l'écart comme signal **seulement** si la confiance est au moins moyenne.
   - Sous ~50 % du bas de la fourchette : signal fort.
   - Entre 50 et 70 % : modéré.
   - « Neuf / scellé » sous ~60 % du prix neuf : fort.
   Un prix bas est normal pour un objet usé, ancien, défectueux, « pour pièces », encombrant, ou si le vendeur veut s'en débarrasser vite. Ne cite jamais de prix précis comme une certitude. »

5. **Signaux forts**, à la manière d'une liste fermée.
   - Paiement d'avance ou hors plateforme mentionné (Western Union, acompte, « vooraf betalen », lien de paiement).
   - Vendeur ou objet à l'étranger avec transporteur ou intermédiaire.
   - Contact imposé hors plateforme (WhatsApp, e-mail dans le texte).
   - Refus de visite pour un objet cher ou un logement.
   - Caution avant visite.
   - Neuf ou scellé à prix cassé.
   - Animal sans numéro d'agrément ou de puce.
   - Ticket d'un événement complet vendu par un particulier.
   « Deux signaux forts **indépendants** justifient un score élevé (≥ 70). »

6. **Combinaisons plutôt que signaux isolés.**
   « Compte récent + objet cher + prix bas + envoi seulement est un profil classique. Chacun de ces éléments seul est banal. »

7. **Ce qui n'est pas un signal.**
   « Ne monte pas le score pour :
   - une donnée inconnue ou absente (avis, âge du compte, nombre d'images, état) : **l'inconnu n'est jamais un signal de risque**, il baisse seulement ta confiance ;
   - un prix de type "Faire une offre / Bieden", "Prix sur demande / Prijs op aanvraag" ou "Gratuit / Gratis" ;
   - un compte ancien sans avis ;
   - une description courte ;
   - un envoi **possible** (l'envoi avec paiement via la plateforme est un flux officiel) ;
   - des photos de catalogue pour un article neuf ou un professionnel ;
   - un prix bas sur un objet usé. »

8. **Professionnels.**
   « Si l'annonce vient visiblement d'un professionnel (nom d'entreprise, lien vers un site, beaucoup d'annonces cohérentes dans un domaine, mentions de TVA, garantie, reprise, financement, prix "sur demande"), **ne la traite pas comme suspecte**. Indique `sellerKind: "professional"` et explique que l'annonce sert de vitrine. Exception : des signaux forts (prix cassé + objet à l'étranger + contact par e-mail seulement) restent valables, car de faux comptes professionnels existent. »

9. **Ce que le score ne peut pas voir.**
   « Les arnaques se jouent souvent dans la conversation : faux lien de paiement ou de livraison, "vérification" à 0,01 €, QR code pour "recevoir" de l'argent, faux service client, passage sur WhatsApp, frais supplémentaires. Ne les invente pas dans tes raisons. Ajoute plutôt un conseil court adapté à la catégorie. »
   - Exemples de conseils : « Ne payez qu'à la remise ou via le paiement de la plateforme. Un lien reçu dans le chat pour payer ou "vérifier" votre compte est une arnaque. 2dehands/2ememain ne demande jamais de vérification IBAN. »
   - Sources : https://www.test-achats.be/famille-prive/boutique-en-ligne/dossier/seconde-main ; https://www.beobank.be/nl/blog/fraude/phishing-op-tweedehandssites-wat-het-en-hoe-vermijd-je-het.html

10. **Raisons.**
    « Chaque raison cite un fait **présent** dans l'annonce : citation courte, prix, catégorie. Pas de raison générique. Écris en FR et en NL avec un vocabulaire belge (kot, GSM, 2ememain/2dehands). »

11. **Ton.**
    Pas de majuscules d'alarme ni de « TOUJOURS / JAMAIS » dans le prompt sauf pour les vraies invariantes (inconnu ≠ risque) : la documentation Anthropic montre que le langage agressif provoque du sur-déclenchement. https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices

12. **Exemples.**
    Inclure 4 à 6 exemples courts et variés :
    - garage professionnel « prix sur demande » → score bas, mention professionnelle ;
    - iPhone récent « neuf scellé » à 35 % du prix, envoi seulement, compte de 2 jours → score élevé ;
    - canapé à 40 € « à enlever » → score bas ;
    - kot avec caution avant visite et propriétaire à l'étranger → score très élevé ;
    - vélo électrique à 10 % de sa valeur sans facture → score moyen-élevé (objet volé) ;
    - « Bieden », vieux compte sans avis, objet usé → score bas.
    https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices

### B. Données d'entrée à ajouter

« Lisible ? » indique si l'extension peut probablement lire la donnée sur la page. Mes estimations restent à vérifier dans le DOM réel de chaque site.

| Champ proposé | Intérêt | Lisible ? |
|---|---|---|
| `sellerKind`: `professional` / `private` / `unknown` | Évite le plus gros faux positif (vitrines pro) ; permet le bandeau « annonce professionnelle » | **2dehands/2ememain** : probable. Indices : lien « Bekijk website / Visiter le site », nom d'entreprise, badge ou position d'annonce payante (Admarkt), nombre d'annonces. **Facebook** : partiel (pages d'entreprise, « boutique ») |
| `priceType` étendu : `fixed` / `bidding` / `on_request` / `see_description` / `free` / `exchange` / `unknown` | « Sur demande » et « Zie omschrijving » ne doivent pas être lus comme « inconnu » ni comme suspects | 2dehands/2ememain : oui, le libellé est affiché à la place du prix. Facebook : prix ou « Gratuit » |
| `hasWebsiteLink` (booléen) | Signal pro | 2dehands/2ememain : oui. Facebook : non |
| `shippingOptions` : `pickup` / `shipping_platform` (bpost via la plateforme) / `shipping_unspecified` | Distinguer l'envoi officiel avec paiement intégré de « envoi seulement » hors plateforme | 2dehands/2ememain : probable (mention de livraison ou paiement sur l'annonce). Facebook Belgique : retrait local surtout |
| `platformPaymentAvailable` (booléen) | La protection acheteur baisse le risque d'envoi | 2dehands/2ememain : à vérifier dans le DOM |
| `maskedContactInDescription` : nombre de téléphones ou e-mails masqués | Contact hors plateforme = signal fort | Oui, calculé localement avant masquage |
| `externalLinkInDescription` (booléen, URL masquée) | Lien vers un faux site | Oui, calcul local |
| `messagingDisabled` (booléen) | Signal clé du cas Radar | À vérifier (bouton « Bericht / Message » absent) |
| `sellerListingCount` + `sellerCategorySpread` (catégories distinctes) | Pro cohérent contre compte piraté qui vend de tout | Partiel : page profil (requête supplémentaire) |
| `sellerHighValueListingsRecent` | Compte ancien soudain actif (piratage Facebook) | Difficile ; page profil |
| `listingAgeDays` / `postedAt` (déjà présent) | Les annonces-appâts sont souvent récentes | Déjà présent |
| `imageCount` (déjà présent) + `imagesLookStock` (estimation du modèle) | Photos de catalogue pour voiture ou logement | Le nombre oui ; le « stock » est inféré par le modèle seulement s'il voit les images (coût) |
| `marketPriceHint` : fourchette d'occasion **estimée par le modèle** avec confiance | Rend l'écart de prix explicite et vérifiable | Pas sur la page. Produit par le LLM, en sortie intermédiaire. Une table locale de prix de référence pour 20 à 50 modèles phares (iPhone, PS5, Switch 2, vélos électriques) serait plus fiable [synthèse] |
| `regulatoryIds` : numéro HK ou d'agrément, numéro de puce, numéro BCE/KBO détectés | Chiots : absence = illégal ; BCE = pro | Oui, regex sur la description (avant masquage si le masquage les touche) |
| `eventDate` / `eventSoldOut` (tickets) | Événement complet = risque élevé | Partiel : le modèle déduit l'événement du titre ; la connaissance « complet » est incertaine |
| `region` (Flandre / Wallonie / Bruxelles) | Règles animaux et caution | Oui, depuis la localisation |
| `condition` (déjà présent) avec `for_parts` / `defective` explicites | Un prix bas est normal | Oui sur 2dehands/2ememain (champ État / Staat) |

### C. Règles locales à ajouter ou ajuster (`apps/extension/lib/rules`)
- **`abroad_seller`** (nouvelle) et **`offsite_contact`** (nouvelle) : listes de phrases ci-dessus. Il faut aussi compter le **contact masqué** dans la description.
- **`new_sealed_cheap`** : ne se déclenche **qu'avec** un prix inférieur à une référence (table locale) ou sur avis du LLM.
- **`deposit_before_viewing`** pour la catégorie immobilier (« caution / waarborg » + « avant visite / vooraf »).
- **`pet_without_id`** : catégorie animaux sans numéro HK ou d'agrément ni puce.
- **`professional_ad`** : signal **informatif**, avec un poids négatif sur le score ou neutre, et un bandeau dédié.
- Ne **pas** ajouter de règle sur les « terminaisons de prix bizarres » ni sur les « militaires » : aucune source solide trouvée.

---

## Annexe : sources non retenues ou à vérifier
- Reddit, toutes les communautés demandées : inaccessible à mes outils. Il faudrait le consulter à la main.
- Pages d'aide de 2dehands et 2ememain (`help.2dehands.be/s/article/...`) : chargement JavaScript, contenu non lu. URL utiles à ouvrir à la main : https://help.2dehands.be/s/article/ik-ben-opgelicht-wat-nu?language=nl_NL et https://help.2dehands.be/s/article/tips-voor-de-verkoper?language=nl_NL
- Police (`politie.be`, `police.be`) : erreur 403 à la lecture directe.
  - https://www.politie.be/5911/nieuws/kijk-uit-voor-oplichters-op-2dehandsbe-en-marketplace
  - Brochure fédérale « Aankoop, verkoop, verhuur fraude » (mai 2025) : https://www.fedpol.prd.cms.fgov.be/5388/sites/5388/files/media/file/2025-05/Aankoop%2C%20verkoop%2C%20verhuur%20fraude%20of%20valse%20webshop_NL.pdf
- Belfius, brochure tweedehandsfraude (mars 2024), PDF non lisible ici : https://www.belfius.be/common/FR/multimedia/MMDownloadableFile/retail/fraude/tweedehandsfraude.pdf
- Fraudehelpdesk, « Terugblik 2025 » (PDF non lisible ici) : https://www.fraudehelpdesk.nl/wp-content/uploads/2026/02/Terugblik-2025.pdf
