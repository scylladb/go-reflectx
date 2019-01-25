// Copyright (C) 2019 ScyllaDB
// Use of this source code is governed by a ALv2-style
// license that can be found in the LICENSE file.

package reflectx_test

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"

	"github.com/scylladb/go-reflectx"
)

// This example demonstrates usage of the reflectx package to automatically bind
// URL parameters to a request model.

// DefaultMapper finds struct fields by the http tag and caches the access
// patterns for faster reflect.Value retrieval.
var DefaultMapper = reflectx.NewMapper("http")

// RequestContext is embedded in SearchRequest.
type RequestContext struct {
	SessionID string `http:"sid"`
}

// SearchRequest is a request model used in search endpoint.
type SearchRequest struct {
	RequestContext
	Labels     []string `http:"l"`
	MaxResults int      `http:"max"`
	Exact      bool     `http:"x"`
}

// Search is an http endpoint implementation.
func Search(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	log.Printf("%+v", r.Form)
	var data SearchRequest
	if err := bindParams(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	log.Printf("%+v", data)
}

// bindParams uses reflectx.Mapper to get reflection of a fields that match
// the URL parameters and calls setValue to do the value assignment.
func bindParams(req *http.Request, dest interface{}) error {
	v := reflect.Indirect(reflect.ValueOf(dest))
	m := DefaultMapper.FieldMap(v)
	for name, values := range req.Form {
		f, ok := m[name]
		if !ok {
			continue
		}
		for _, value := range values {
			if err := setValue(f, value); err != nil {
				return fmt.Errorf("%s: %v", name, err)
			}
		}
	}
	return nil
}

// setValue unmarshals string representation of string, int or bool into
// a field using a "kind switch".
func setValue(v reflect.Value, value string) error {
	switch v.Kind() {
	// Special handling of slices.
	case reflect.Slice:
		elem := reflect.New(v.Type().Elem()).Elem()
		if err := setValue(elem, value); err != nil {
			return err
		}
		v.Set(reflect.Append(v, elem))
	// Handling of selected types...
	case reflect.String:
		v.SetString(value)
	case reflect.Int:
		i, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return err
		}
		v.SetInt(i)
	case reflect.Bool:
		b, err := strconv.ParseBool(value)
		if err != nil {
			return err
		}
		v.SetBool(b)
	default:
		return fmt.Errorf("unsupported kind %s", v.Type())
	}
	return nil
}

func TestSearch(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/search?sid=id&l=foo&l=bar&max=100&x=true", nil)
	Search(w, r)
	if w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
}
