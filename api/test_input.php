<?php
header('Content-Type: application/json; charset=utf-8');
$raw = file_get_contents('php://input');
$rest = json_decode($raw, true);
echo json_encode(array('raw'=>$raw,'decoded'=>$rest));
